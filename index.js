import 'dotenv/config';
import { Bot, session, InlineKeyboard } from 'grammy';
import { conversations, createConversation } from '@grammyjs/conversations';
import db, { initDB } from './database.js';

// Запускаємо базу даних
initDB();

const bot = new Bot(process.env.BOT_TOKEN);

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
  if (!user) return ctx.reply('Будь ласка, спочатку заповніть профіль командою /set_profile');

  await ctx.reply('Що ви з\'їли?');
  const response = await conversation.wait();
  if (!response.message?.text) return ctx.reply('Будь ласка, введіть назву страви текстом.');
  const rawText = response.message.text;

  await ctx.reply('Бажаєте додати нотатку? Відправте текст або /skip для пропуску.');
  const noteMsg = await conversation.wait();
  let notes = null;
  if (noteMsg.message?.text && noteMsg.message.text !== '/skip') {
    notes = noteMsg.message.text;
  }

  db.prepare('INSERT INTO meals (user_id, raw_text, calories_estimated, notes) VALUES (?, ?, ?, ?)')
    .run(ctx.from.id, rawText, 0, notes);

  await ctx.reply('Прийом їжі збережено ✅');
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
  const meals = db.prepare(`
    SELECT *, time(timestamp, 'localtime') as clock 
    FROM meals 
    WHERE user_id = ? AND date(timestamp, 'localtime') = date('now', 'localtime')
    ORDER BY timestamp ASC
  `).all(ctx.from.id);

  if (meals.length === 0) return ctx.reply('Сьогодні ще немає прийомів їжі.');

  let total = 0;
  let message = '📅 <b>Сьогодні ви зʼїли:</b>\n\n';
  
  meals.forEach((meal, index) => {
    message += `${index + 1}. 🕒 ${meal.clock} - <b>${escapeHTML(meal.raw_text)}</b> (${meal.calories_estimated} kcal)\n`;
    if (meal.notes) message += `   📝 <i>${escapeHTML(meal.notes)}</i>\n`;
    message += '\n';
    total += meal.calories_estimated;
  });
  
  message += `🏁 <b>Всього:</b> ${total} kcal`;
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
