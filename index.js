import 'dotenv/config';
import { Bot, session, InlineKeyboard, Keyboard } from 'grammy';
import { conversations, createConversation } from '@grammyjs/conversations';
import { GoogleGenerativeAI } from "@google/generative-ai";
import db, { initDB } from './database.js';

// Запускаємо базу даних
initDB();

const bot = new Bot(process.env.BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Допоміжна функція для логування помилок
const logError = (error, context = '') => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ERROR ${context}:`, error.message || error);
};

// Допоміжна функція для затримки (sleep)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Допоміжна функція для оцінки калорій через Gemini з Retry
async function estimateCalories(foodText) {
  const defaultResponse = { items: [], total_calories: 0, confidence: 0 };
  
  if (!process.env.GEMINI_API_KEY) {
    logError('GEMINI_API_KEY is not set', 'estimateCalories');
    return defaultResponse;
  }
  
  const maxRetries = 2; 
  const modelName = "gemini-3-flash-preview";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const model = genAI.getGenerativeModel({ 
        model: modelName,
        generationConfig: { responseMimeType: "application/json" }
      });

      const prompt = `Ви професійний дієтолог. Проаналізуйте страву: "${foodText}". 
      Обов'язково виконайте наступне:
      1. Розбийте страву на окремі продукти.
      2. Оцініть калорійність кожного продукту та його приблизну вагу (округлюйте до цілих).
      3. Порахуйте загальну кількість калорій (total_calories).
      4. Вкажіть вашу впевненість в оцінці (confidence від 0 до 1).
      
      Поверніть відповідь ТІЛЬКИ у форматі JSON без жодного зайвого тексту:
      {
        "items": [
          { "name": "назва продукту", "grams": число, "calories": число }
        ],
        "total_calories": число,
        "confidence": число
      }
      Якщо вхідний текст не є описом їжі, поверніть {"items": [], "total_calories": 0, "confidence": 0}.`;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      const data = JSON.parse(response.text());
      
      return {
        items: Array.isArray(data.items) ? data.items : [],
        total_calories: Math.round(data.total_calories || 0),
        confidence: parseFloat(data.confidence || 0)
      };
    } catch (error) {
      logError(`Attempt ${attempt} failed for model ${modelName}: ${error.message}`, 'estimateCalories');
      if (attempt < maxRetries) {
        await sleep(1000);
      }
    }
  }

  return defaultResponse;
}

// Простий Rate Limit (1 запит на секунду)
const userLastRequest = new Map();
const rateLimitMiddleware = async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return next();

  const now = Date.now();
  const lastRequest = userLastRequest.get(userId) || 0;
  
  if (now - lastRequest < 1000) {
    return ctx.reply('⏳ Зачекайте хвилинку, ви надсилаєте запити занадто швидко!');
  }

  userLastRequest.set(userId, now);
  return next();
};

// Налаштування сесії
bot.use(rateLimitMiddleware);
bot.use(session({ initial: () => ({}) }));
bot.use(conversations());

// Валідатор для чисел
const validateInput = (text, min, max) => {
  const num = parseInt(text, 10);
  return !isNaN(num) && num >= min && num <= max;
};

// Допоміжна функція для безпечного виводу тексту
const escapeHTML = (str) => {
  if (!str) return '';
  return str.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[m]);
};

// Головне меню
const mainKeyboard = new Keyboard()
  .text('➕ Add meal')
  .text('📊 Today')
  .row()
  .text('📋 Plan')
  .text('💡 Advice')
  .row()
  .text('⚙️ Set profile')
  .resized();

// Функція для відображення плану
const planHandler = async (ctx) => {
  try {
    const profile = db.prepare('SELECT goal, tdee FROM users WHERE telegram_id = ?').get(ctx.from.id);
    
    if (!profile) {
      return ctx.reply('⚠️ Спочатку заповніть профіль через /set_profile');
    }
    
    if (!profile.goal) {
      return ctx.reply('⚠️ Оновіть профіль і виберіть вашу ціль');
    }

    const goalLabels = {
      lose: 'схуднення',
      maintain: 'підтримка ваги',
      gain: 'набір маси'
    };

    const explanations = {
      lose: 'Це помірний дефіцит калорій для поступового зниження ваги.',
      maintain: 'Це оптимальна кількість калорій для збереження поточної ваги.',
      gain: 'Це невеликий профіцит калорій для поступового набору маси.'
    };

    await ctx.reply('⏳ <b>Завантажую ваш персональний план...</b>', { parse_mode: 'HTML' });

    let mealIdeas = '';
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
      const prompt = `Дай 3 дуже короткі та прості ідеї страв для цілі: ${goalLabels[profile.goal]}. 
      Без медичних порад. Кожна страва одним рядком. Мова: українська.
      Формат:
      - Страва 1
      - Страва 2
      - Страва 3`;
      
      const result = await model.generateContent(prompt);
      mealIdeas = result.response.text().trim();
    } catch (aiError) {
      logError(aiError, 'planHandler/AI');
      mealIdeas = '- Не вдалося завантажити ідеї страв.';
    }

    const message = `Ваша ціль: <b>${goalLabels[profile.goal]}</b>\n` +
      `Рекомендована норма:\n` +
      `<b>${profile.tdee} kcal / день</b>\n\n` +
      `${explanations[profile.goal]}\n\n` +
      `🍴 <b>Ідеї страв:</b>\n${mealIdeas}\n\n` +
      `<i>Це загальні рекомендації, а не медична порада.</i>`;

    ctx.reply(message, { parse_mode: 'HTML', reply_markup: mainKeyboard });
  } catch (error) {
    logError(error, 'plan');
    replyWithError(ctx);
  }
};

// Функція для отримання поради
async function getAdvice(ctx) {
  try {
    const profile = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(ctx.from.id);
    
    if (!profile) {
      return ctx.reply('⚠️ Спочатку заповніть профіль через /set_profile');
    }
    
    if (!profile.goal) {
      return ctx.reply('⚠️ Оновіть профіль і виберіть вашу ціль');
    }

    const meals = db.prepare(`
      SELECT raw_text, calories_estimated 
      FROM meals 
      WHERE user_id = ? AND date(timestamp, 'localtime') = date('now', 'localtime')
    `).all(ctx.from.id);

    const mealList = meals.length > 0 
      ? meals.map(m => `${m.raw_text} (${m.calories_estimated} ккал)`).join(', ')
      : 'нічого';

    const goalLabels = { lose: 'схуднення', maintain: 'підтримка ваги', gain: 'набір маси' };
    
    await ctx.reply('⏳ <b>Готую персональну пораду...</b>', { parse_mode: 'HTML' });

    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
    const prompt = `Я ${profile.sex.toLowerCase()}, мені ${profile.age} років, зріст ${profile.height} см, вага ${profile.weight} кг, ціль — ${goalLabels[profile.goal]}. 
    Сьогодні я з'їв: ${mealList}. 
    Дай одну коротку та влучну пораду на вечір (1-2 речення) українською мовою.`;

    const result = await model.generateContent(prompt);
    const advice = result.response.text().trim();

    await ctx.reply(`💡 <b>Порада дня:</b>\n\n${advice}`, { 
      parse_mode: 'HTML',
      reply_markup: mainKeyboard 
    });
  } catch (error) {
    logError(error, 'getAdvice');
    replyWithError(ctx);
  }
}

// Допоміжна функція для повідомлення про помилку користувачу
const replyWithError = async (ctx) => {
  try {
    await ctx.reply('⚠️ Сталася помилка. Спробуйте ще раз пізніше.', { reply_markup: mainKeyboard });
  } catch (e) {
    console.error('Failed to send error message:', e);
  }
};

// --- КОНВЕРСЕЙШНИ (ДІАЛОГИ) ---

// 1. Профіль (/set_profile)
async function setProfile(conversation, ctx) {
  try {
    await ctx.reply('🚀 <b>Почнемо налаштування вашого профілю!</b>\n\nЦе допоможе мені точно розрахувати вашу норму калорій.', { parse_mode: 'HTML' });

    // 1️⃣ Вік
    await ctx.reply('1️⃣ <b>Введіть ваш вік</b> (від 10 до 100 років):\n\n<i>Це потрібно для розрахунку базового метаболізму.</i>', { parse_mode: 'HTML' });
    let age;
    while (true) {
      const { message } = await conversation.wait();
      if (message?.text && validateInput(message.text, 10, 100)) {
        age = parseInt(message.text, 10);
        break;
      }
      await ctx.reply('❌ Будь ласка, введіть вік від 10 до 100 років:');
    }

    // 2️⃣ Зріст
    await ctx.reply('2️⃣ <b>Введіть ваш зріст у см</b> (від 100 до 250):\n\n<i>Зріст впливає на площу поверхні тіла та енерговитрати.</i>', { parse_mode: 'HTML' });
    let height;
    while (true) {
      const { message } = await conversation.wait();
      if (message?.text && validateInput(message.text, 100, 250)) {
        height = parseInt(message.text, 10);
        break;
      }
      await ctx.reply('❌ Будь ласка, введіть зріст від 100 до 250 см:');
    }

    // 3️⃣ Вага
    await ctx.reply('3️⃣ <b>Введіть вашу вагу у кг</b> (від 30 до 300):\n\n<i>Вага — ключовий показник для визначення денної норми калорій.</i>', { parse_mode: 'HTML' });
    let weight;
    while (true) {
      const { message } = await conversation.wait();
      if (message?.text && validateInput(message.text, 30, 300)) {
        weight = parseInt(message.text, 10);
        break;
      }
      await ctx.reply('❌ Будь ласка, введіть вагу від 30 до 300 кг:');
    }

    // 4️⃣ Стать
    const keyboard = new InlineKeyboard().text('Чоловік 👨', 'male').text('Жінка 👩', 'female');
    await ctx.reply('4️⃣ <b>Оберіть вашу стать</b>:\n\n<i>Формули розрахунку калорій відрізняються для чоловіків та жінок.</i>', { 
      reply_markup: keyboard,
      parse_mode: 'HTML' 
    });
    
    const queryCtx = await conversation.waitForCallbackQuery(['male', 'female']);
    const sex = queryCtx.callbackQuery.data === 'male' ? 'Чоловік' : 'Жінка';
    await queryCtx.answerCallbackQuery();
    await queryCtx.reply(`✅ Обрано: ${sex}`);

    // 5️⃣ Активність
    const activityKeyboard = new InlineKeyboard()
      .text('Мінімальна (сидяча робота)', '1.2').row()
      .text('Низька (1-3 тренування/тиждень)', '1.375').row()
      .text('Середня (3-5 тренувань/тиждень)', '1.55').row()
      .text('Висока (6-7 тренувань/тиждень)', '1.725').row()
      .text('Дуже висока (важка фізична праця)', '1.9');
    
    await ctx.reply('5️⃣ <b>Оберіть ваш рівень активності</b>:\n\n<i>Це допоможе врахувати спалені калорії під час руху.</i>', { 
      reply_markup: activityKeyboard,
      parse_mode: 'HTML' 
    });
    
    const actCtx = await conversation.waitForCallbackQuery(['1.2', '1.375', '1.55', '1.725', '1.9']);
    const activityMultiplier = parseFloat(actCtx.callbackQuery.data);
    const activityLevel = actCtx.callbackQuery.data;
    await actCtx.answerCallbackQuery();

    // 6️⃣ Ціль
    const goalKeyboard = new InlineKeyboard()
      .text('🔻 Схуднення', 'lose').row()
      .text('⚖️ Підтримка', 'maintain').row()
      .text('🔺 Набір маси', 'gain');

    await ctx.reply('6️⃣ <b>Яка ваша ціль?</b>', { 
      reply_markup: goalKeyboard,
      parse_mode: 'HTML' 
    });

    const goalCtx = await conversation.waitForCallbackQuery(['lose', 'maintain', 'gain']);
    const goal = goalCtx.callbackQuery.data;
    await goalCtx.answerCallbackQuery();

    let bmr = (sex === 'Чоловік') 
      ? (10 * weight + 6.25 * height - 5 * age + 5) 
      : (10 * weight + 6.25 * height - 5 * age - 161);
    
    let tdee = Math.round(bmr * activityMultiplier);

    // Коригування залежно від цілі
    if (goal === 'lose') {
      tdee = tdee - 400; // Дефіцит 400 ккал
    } else if (goal === 'gain') {
      tdee = tdee + 300; // Профіцит 300 ккал
    }
    
    bmr = Math.round(bmr);

    try {
      db.prepare(`
        INSERT OR REPLACE INTO users (telegram_id, sex, age, height, weight, activity_level, bmr, tdee, goal)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(ctx.from.id, sex, age, height, weight, activityLevel, bmr, tdee, goal);
    } catch (dbError) {
      logError(dbError, 'setProfile/database');
      return replyWithError(ctx);
    }

    await ctx.reply('✅ <b>Профіль успішно збережено!</b>\n\nТепер ви можете додавати прийоми їжі за допомогою кнопки "➕ Add meal".', { 
      parse_mode: 'HTML',
      reply_markup: mainKeyboard
    });
  } catch (error) {
    logError(error, 'setProfile');
    await replyWithError(ctx);
  }
}

// 2. Додати прийом їжі швидко (/add_meal)
async function addMeal(conversation, ctx) {
  try {
    let user;
    try {
      user = db.prepare('SELECT telegram_id FROM users WHERE telegram_id = ?').get(ctx.from.id);
    } catch (dbError) {
      logError(dbError, 'addMeal/database_check');
      return replyWithError(ctx);
    }

    if (!user) {
      return ctx.reply('⚠️ Будь ласка, спочатку заповніть профіль за допомогою кнопки "⚙️ Set profile"', {
        reply_markup: mainKeyboard
      });
    }

    await ctx.reply('🥗 <b>Що ви сьогодні їли?</b>', { parse_mode: 'HTML' });
    
    const response = await conversation.wait();
    if (!response.message?.text) {
      return ctx.reply('❌ Будь ласка, надішліть назву страви текстом.', { reply_markup: mainKeyboard });
    }
    const rawText = response.message.text;

    await ctx.reply('⏳ <b>Аналізую страву...</b>', { parse_mode: 'HTML' });
    
    let result;
    try {
      result = await conversation.external(() => estimateCalories(rawText));
    } catch (e) {
      logError(e, 'addMeal/estimateCalories');
    }
    
    const isValid = result && 
                    Array.isArray(result.items) && 
                    typeof result.total_calories === 'number' && 
                    result.total_calories > 0;

    let total_calories, items;

    if (!isValid) {
      await ctx.reply('🤨 Не вдалося автоматично визначити калорії. Введіть кількість калорій вручну (число):');
      while (true) {
        const { message } = await conversation.wait();
        if (message?.text && validateInput(message.text, 1, 5000)) {
          total_calories = parseInt(message.text, 10);
          items = [];
          break;
        }
        await ctx.reply('🔢 Введіть число від 1 до 5000:');
      }
    } else {
      total_calories = result.total_calories;
      items = result.items;
    }

    try {
      db.prepare('INSERT INTO meals (user_id, raw_text, calories_estimated, details_json) VALUES (?, ?, ?, ?)')
        .run(ctx.from.id, rawText, total_calories, JSON.stringify(result || { manual: true }));
    } catch (dbError) {
      logError(dbError, 'addMeal/database_save');
      return replyWithError(ctx);
    }

    let detailsMessage = `✅ <b>Запис збережено!</b>\n\n`;
    if (items && items.length > 0) {
      detailsMessage += items.map(item => `🔹 ${item.name} — <b>${item.calories}</b> kcal`).join('\n');
      detailsMessage += `\n\n🏁 <b>Всього:</b> ${total_calories} kcal`;
    } else {
      detailsMessage += `🍽️ Страва: ${escapeHTML(rawText)}\n🔥 Калорійність: <b>${total_calories}</b> kcal`;
    }

    await ctx.reply(detailsMessage, { 
      parse_mode: 'HTML',
      reply_markup: mainKeyboard
    });
  } catch (error) {
    logError(error, 'addMeal');
    await replyWithError(ctx);
  }
}

// 3. Додати з калоріями (/log_food)
async function logFood(conversation, ctx) {
  try {
    const user = db.prepare('SELECT telegram_id FROM users WHERE telegram_id = ?').get(ctx.from.id);
    if (!user) return ctx.reply('Будь ласка, спочатку заповніть профіль командою /set_profile');

    await ctx.reply('Що ви з\'їли?');
    const foodMsg = await conversation.wait();
    if (!foodMsg.message?.text) return ctx.reply('Будь ласка, введіть назву страви текстом.');
    const rawText = foodMsg.message.text;

    await ctx.reply('Скільки калорій?');
    let calories;
    while (true) {
      const { message } = await conversation.wait();
      if (message?.text && validateInput(message.text, 1, 5000)) {
        calories = parseInt(message.text, 10);
        break;
      }
      await ctx.reply('Введіть число від 1 до 5000:');
    }

    await ctx.reply('Додати нотатку? Напишіть або відправте /skip.');
    const noteMsg = await conversation.wait();
    let notes = null;
    if (noteMsg.message?.text && noteMsg.message.text !== '/skip') {
      notes = noteMsg.message.text;
    }

    db.prepare('INSERT INTO meals (user_id, raw_text, calories_estimated, notes) VALUES (?, ?, ?, ?)')
      .run(ctx.from.id, rawText, calories, notes);

    await ctx.reply(`✅ Запис додано: ${escapeHTML(rawText)} - ${calories} ккал.`, { reply_markup: mainKeyboard });
  } catch (error) {
    logError(error, 'logFood');
    await replyWithError(ctx);
  }
}

bot.use(createConversation(setProfile));
bot.use(createConversation(addMeal));
bot.use(createConversation(logFood));

// --- КОМАНДИ ---

const startHandler = (ctx) => {
  try {
    ctx.reply('Привіт! Я твій помічник з калорій. Оберіть дію в меню нижче:', {
      reply_markup: mainKeyboard
    });
  } catch (e) {
    logError(e, 'startHandler');
  }
};

const setProfileHandler = (ctx) => ctx.conversation.enter('setProfile');
const addMealHandler = (ctx) => ctx.conversation.enter('addMeal');
const logFoodHandler = (ctx) => ctx.conversation.enter('logFood');

const todayHandler = (ctx) => {
  try {
    const profile = db.prepare('SELECT tdee FROM users WHERE telegram_id = ?').get(ctx.from.id);
    
    if (!profile) {
      return ctx.reply('⚠️ Спочатку заповніть профіль через /set_profile');
    }

    const meals = db.prepare(`
      SELECT *, time(timestamp, 'localtime') as clock 
      FROM meals 
      WHERE user_id = ? AND date(timestamp, 'localtime') = date('now', 'localtime')
      ORDER BY timestamp ASC
    `).all(ctx.from.id);

    if (meals.length === 0) {
      return ctx.reply('📅 <b>Сьогодні ще немає прийомів їжі.</b>', { 
        parse_mode: 'HTML',
        reply_markup: mainKeyboard 
      });
    }

    let total = 0;
    let message = '📅 <b>Сьогодні ви зʼїли:</b>\n\n';
    
    meals.forEach((meal, index) => {
      message += `${index + 1}. 🕒 ${meal.clock} — <b>${escapeHTML(meal.raw_text)}</b>\n`;
      message += `   🔥 ${meal.calories_estimated} kcal\n`;
      if (meal.notes) message += `   📝 <i>${escapeHTML(meal.notes)}</i>\n`;
      message += '\n';
      total += meal.calories_estimated;
    });
    
    message += `🏁 <b>Всього за день:</b> ${total} kcal`;
    
    if (profile && profile.tdee) {
      const remaining = profile.tdee - total;
      message += `\n🎯 <b>Ваша норма:</b> ${profile.tdee} kcal`;
      if (remaining > 0) {
        message += `\n✅ Залишилось: ${remaining} kcal`;
      } else if (remaining < 0) {
        message += `\n⚠️ Перевищення: ${Math.abs(remaining)} kcal`;
      }
    }

    ctx.reply(message, { 
      parse_mode: 'HTML',
      reply_markup: mainKeyboard
    });
  } catch (error) {
    logError(error, 'todayHandler');
    replyWithError(ctx);
  }
};

bot.command('info', (ctx) => {
  ctx.reply('ℹ️ <b>Про бота:</b>\nВерсія: 1.7.0\nБаза даних: SQLite\nФункції: Розрахунок калорій, логування харчування з нотатками та часом.', { parse_mode: 'HTML' });
});

bot.command('start', startHandler);
bot.command('set_profile', setProfileHandler);
bot.command('add_meal', addMealHandler);
bot.command('log_food', logFoodHandler);
bot.command('today', todayHandler);
bot.command('advice', getAdvice);
bot.command('plan', planHandler);

bot.command('my_profile', (ctx) => {
  try {
    const profile = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(ctx.from.id);
    
    if (!profile) {
      return ctx.reply('⚠️ Спочатку заповніть профіль через /set_profile');
    }
    
    if (!profile.goal) {
      return ctx.reply('⚠️ Оновіть профіль і виберіть вашу ціль');
    }

    const goalLabels = {
      lose: 'Схуднення 📉',
      maintain: 'Підтримка ваги ⚖️',
      gain: 'Набір маси 📈'
    };

    const message = `📋 <b>Ваш профіль:</b>\n\n` +
      `👤 Стать: ${profile.sex}\n` +
      `🎂 Вік: ${profile.age} років\n` +
      `📏 Зріст: ${profile.height} см\n` +
      `⚖️ Вага: ${profile.weight} кг\n` +
      `🎯 Ціль: ${goalLabels[profile.goal] || 'Не вказано'}\n\n` +
      `🔥 <b>BMR:</b> ${profile.bmr} ккал\n` +
      `🚀 <b>TDEE:</b> ${profile.tdee} ккал`;
    ctx.reply(message, { parse_mode: 'HTML', reply_markup: mainKeyboard });
  } catch (error) {
    logError(error, 'my_profile');
    replyWithError(ctx);
  }
});

bot.hears('➕ Add meal', addMealHandler);
bot.hears('📊 Today', todayHandler);
bot.hears('📋 Plan', planHandler);
bot.hears('⚙️ Set profile', setProfileHandler);
bot.hears('💡 Advice', getAdvice);

bot.command('history', (ctx) => {
  try {
    const logs = db.prepare(`
      SELECT *, datetime(timestamp, 'localtime') as dt 
      FROM meals 
      WHERE user_id = ? 
      ORDER BY timestamp DESC 
      LIMIT 10
    `).all(ctx.from.id);

    if (logs.length === 0) return ctx.reply('Історія порожня.');

    let message = '🍏 <b>Останні 10 записів:</b>\n\n';
    logs.forEach((log, index) => {
      message += `${index + 1}. 🕒 ${log.dt}\n`;
      message += `   🔹 <b>${escapeHTML(log.raw_text)}</b> (${log.calories_estimated} ккал)\n`;
      if (log.notes) message += `   📝 <i>${escapeHTML(log.notes)}</i>\n`;
      message += '\n';
    });
    ctx.reply(message, { parse_mode: 'HTML', reply_markup: mainKeyboard });
  } catch (error) {
    logError(error, 'history');
    replyWithError(ctx);
  }
});

bot.command('help', (ctx) => {
  ctx.reply(
    '🤖 <b>Доступні команди:</b>\n\n' +
    '/start - Почати роботу\n' +
    '/set_profile - Заповнити дані профілю\n' +
    '/add_meal - Додати прийом їжі (швидко)\n' +
    '/log_food - Логування з калоріями та нотаткою\n' +
    '/today - Прийоми їжі за сьогодні\n' +
    '/plan - Ваш персональний план\n' +
    '/history - Останні 10 записів\n' +
    '/my_profile - Профіль та розрахунки\n' +
    '/help - Список команд\n' +
    '/info - Про бота',
    { parse_mode: 'HTML', reply_markup: mainKeyboard }
  );
});

bot.catch((err) => {
  const ctx = err.ctx;
  logError(err.error, `Update ${ctx.update.update_id}`);
  replyWithError(ctx);
});

bot.start();
console.log('🚀 Бот запущений з новими функціями!');
