import 'dotenv/config';
import { Bot, session, InlineKeyboard } from 'grammy';
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

// Допоміжна функція для оцінки калорій через Gemini
async function estimateCalories(foodText) {
  const defaultResponse = { items: [], total_calories: 0, confidence: 0 };
  
  if (!process.env.GEMINI_API_KEY) {
    logError('GEMINI_API_KEY is not set', 'estimateCalories');
    return defaultResponse;
  }
  
  const modelsToTry = ["gemini-3-flash-preview", "gemini-flash-latest", "gemini-2.0-flash"];

  for (const modelName of modelsToTry) {
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
      if (error.message.includes('429') || error.message.includes('quota')) {
        logError(`Quota exceeded for model ${modelName}`, 'estimateCalories');
        break; 
      }
      logError(`Error with model ${modelName}: ${error.message}`, 'estimateCalories');
    }
  }

  return defaultResponse;
}

// Налаштування сесії
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

// --- КОНВЕРСЕЙШНИ (ДІАЛОГИ) ---

// 1. Профіль (/set_profile)
async function setProfile(conversation, ctx) {
  const keyboard = new InlineKeyboard().text('Чоловік', 'male').text('Жінка', 'female');
  await ctx.reply('Оберіть вашу стать:', { reply_markup: keyboard });
  
  const queryCtx = await conversation.waitForCallbackQuery(['male', 'female']);
  const sex = queryCtx.callbackQuery.data === 'male' ? 'Чоловік' : 'Жінка';
  await queryCtx.answerCallbackQuery();
  await queryCtx.reply(`Обрано: ${sex}`);

  await ctx.reply('Введіть ваш вік (від 10 до 100 років):');
  let age;
  while (true) {
    const { message } = await conversation.wait();
    if (message?.text && validateInput(message.text, 10, 100)) {
      age = parseInt(message.text, 10);
      break;
    }
    await ctx.reply('Введіть число від 10 до 100:');
  }

  await ctx.reply('Введіть ваш зріст у см (від 100 до 250):');
  let height;
  while (true) {
    const { message } = await conversation.wait();
    if (message?.text && validateInput(message.text, 100, 250)) {
      height = parseInt(message.text, 10);
      break;
    }
    await ctx.reply('Введіть число від 100 до 250:');
  }

  await ctx.reply('Введіть вашу вагу у кг (від 30 до 300):');
  let weight;
  while (true) {
    const { message } = await conversation.wait();
    if (message?.text && validateInput(message.text, 30, 300)) {
      weight = parseInt(message.text, 10);
      break;
    }
    await ctx.reply('Введіть число від 30 до 300:');
  }

  const activityKeyboard = new InlineKeyboard()
    .text('Мінімальна', '1.2').row()
    .text('Низька', '1.375').row()
    .text('Середня', '1.55').row()
    .text('Висока', '1.725').row()
    .text('Дуже висока', '1.9');
  await ctx.reply('Оберіть ваш рівень активності:', { reply_markup: activityKeyboard });
  
  const actCtx = await conversation.waitForCallbackQuery(['1.2', '1.375', '1.55', '1.725', '1.9']);
  const activityMultiplier = parseFloat(actCtx.callbackQuery.data);
  const activityLevel = actCtx.callbackQuery.data;
  await actCtx.answerCallbackQuery();

  let bmr = (sex === 'Чоловік') 
    ? (10 * weight + 6.25 * height - 5 * age + 5) 
    : (10 * weight + 6.25 * height - 5 * age - 161);
  const tdee = Math.round(bmr * activityMultiplier);
  bmr = Math.round(bmr);

  db.prepare(`
    INSERT OR REPLACE INTO users (telegram_id, sex, age, height, weight, activity_level, bmr, tdee)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ctx.from.id, sex, age, height, weight, activityLevel, bmr, tdee);

  await ctx.reply('✅ Профіль збережено! Використовуйте /my_profile');
}

// 2. Додати прийом їжі швидко (/add_meal)
async function addMeal(conversation, ctx) {
  const user = db.prepare('SELECT telegram_id FROM users WHERE telegram_id = ?').get(ctx.from.id);
  if (!user) return ctx.reply('⚠️ Будь ласка, спочатку заповніть профіль командою /set_profile');

  await ctx.reply('🥗 <b>Що ви з\'їли?</b>\n(Наприклад: "Гречка 200г та куряча відбивна")', { parse_mode: 'HTML' });
  const response = await conversation.wait();
  if (!response.message?.text) return ctx.reply('❌ Будь ласка, введіть назву страви текстом.');
  const rawText = response.message.text;

  await ctx.reply('⏳ <b>Зачекайте, я аналізую склад...</b>', { parse_mode: 'HTML' });
  
  let result;
  try {
    result = await conversation.external(() => estimateCalories(rawText));
  } catch (e) {
    logError(e, 'addMeal/estimateCalories');
  }
  
  // Валідація та Fallback
  const isValid = result && 
                  Array.isArray(result.items) && 
                  typeof result.total_calories === 'number' && 
                  result.total_calories > 0;

  let total_calories, items, confidence;

  if (!isValid) {
    await ctx.reply('🤨 <b>Хмм, не можу розпізнати цю страву автоматично.</b>\nБудь ласка, введіть кількість калорій вручну:', { parse_mode: 'HTML' });
    while (true) {
      const { message } = await conversation.wait();
      if (message?.text && validateInput(message.text, 1, 5000)) {
        total_calories = parseInt(message.text, 10);
        items = [];
        confidence = 1.0;
        break;
      }
      await ctx.reply('🔢 Введіть число від 1 до 5000:');
    }
  } else {
    total_calories = result.total_calories;
    items = result.items;
    confidence = result.confidence;
  }

  let detailsMessage = '📊 <b>Результат аналізу:</b>\n\n';
  if (items && items.length > 0) {
    detailsMessage += items.map(item => `🔹 ${item.name} — <b>${item.calories}</b> kcal`).join('\n');
    detailsMessage += `\n\n🏁 <b>Всього:</b> ${total_calories} kcal`;
  } else {
    detailsMessage += `✅ <b>Збережено:</b> ${total_calories} kcal`;
  }
  
  const confidencePercent = Math.round(confidence * 100);
  detailsMessage += `\n🎯 Впевненість: ${confidencePercent}%`;
  detailsMessage += `\n\n<i>💡 Оцінка орієнтовна.</i>`;

  await ctx.reply('📝 <b>Додати нотатку?</b>\nНапишіть текст або відправте /skip:', { parse_mode: 'HTML' });
  const noteMsg = await conversation.wait();
  let notes = null;
  if (noteMsg.message?.text && noteMsg.message.text !== '/skip') {
    notes = noteMsg.message.text;
  }

  db.prepare('INSERT INTO meals (user_id, raw_text, calories_estimated, notes, details_json) VALUES (?, ?, ?, ?, ?)')
    .run(ctx.from.id, rawText, total_calories, notes, JSON.stringify(result || { manual: true }));

  await ctx.reply(`✅ <b>Запис додано!</b>\n\n${detailsMessage}`, { parse_mode: 'HTML' });
}

// 3. Додати з калоріями (/log_food)
async function logFood(conversation, ctx) {
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

  await ctx.reply(`✅ Запис додано: ${escapeHTML(rawText)} - ${calories} ккал.`);
}

bot.use(createConversation(setProfile));
bot.use(createConversation(addMeal));
bot.use(createConversation(logFood));

// --- КОМАНДИ ---

bot.command('info', (ctx) => {
  ctx.reply('ℹ️ <b>Про бота:</b>\nВерсія: 1.5.0\nБаза даних: SQLite\nФункції: Розрахунок калорій, логування харчування з нотатками та часом.', { parse_mode: 'HTML' });
});

bot.command('start', (ctx) => {
  ctx.reply('Привіт! Я твій помічник з калорій.\n/set_profile - налаштувати дані\n/help - список команд');
});

bot.command('set_profile', (ctx) => ctx.conversation.enter('setProfile'));
bot.command('add_meal', (ctx) => ctx.conversation.enter('addMeal'));
bot.command('log_food', (ctx) => ctx.conversation.enter('logFood'));

bot.command('my_profile', (ctx) => {
  const profile = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(ctx.from.id);
  if (!profile) return ctx.reply('Спочатку пройдіть реєстрацію /set_profile');

  const message = `📋 <b>Ваш профіль:</b>\n\n` +
    `👤 Стать: ${profile.sex}\n` +
    `🎂 Вік: ${profile.age} років\n` +
    `📏 Зріст: ${profile.height} см\n` +
    `⚖️ Вага: ${profile.weight} кг\n\n` +
    `🔥 <b>BMR:</b> ${profile.bmr} ккал\n` +
    `🚀 <b>TDEE:</b> ${profile.tdee} ккал`;
  ctx.reply(message, { parse_mode: 'HTML' });
});

bot.command('today', (ctx) => {
  const profile = db.prepare('SELECT tdee FROM users WHERE telegram_id = ?').get(ctx.from.id);
  const meals = db.prepare(`
    SELECT *, time(timestamp, 'localtime') as clock 
    FROM meals 
    WHERE user_id = ? AND date(timestamp, 'localtime') = date('now', 'localtime')
    ORDER BY timestamp ASC
  `).all(ctx.from.id);

  if (meals.length === 0) return ctx.reply('📅 <b>Сьогодні ще немає прийомів їжі.</b>', { parse_mode: 'HTML' });

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

  ctx.reply(message, { parse_mode: 'HTML' });
});

bot.command('history', (ctx) => {
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
  ctx.reply(message, { parse_mode: 'HTML' });
});

bot.command('help', (ctx) => {
  ctx.reply(
    '🤖 <b>Доступні команди:</b>\n\n' +
    '/start - Почати роботу\n' +
    '/set_profile - Заповнити дані профілю\n' +
    '/add_meal - Додати прийом їжі (швидко)\n' +
    '/log_food - Логування з калоріями та нотаткою\n' +
    '/today - Прийоми їжі за сьогодні\n' +
    '/history - Останні 10 записів\n' +
    '/my_profile - Профіль та розрахунки\n' +
    '/help - Список команд\n' +
    '/info - Про бота',
    { parse_mode: 'HTML' }
  );
});

bot.catch((err) => console.error('Помилка:', err));

bot.start();
console.log('🚀 Бот запущений з новими функціями!');
