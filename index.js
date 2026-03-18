import 'dotenv/config';
import { Bot, session, InlineKeyboard } from 'grammy';
import { conversations, createConversation } from '@grammyjs/conversations';

const bot = new Bot(process.env.BOT_TOKEN);

// Налаштування сесії (initial: створює об'єкт для зберігання даних профілю)
bot.use(session({ initial: () => ({ userProfile: null }) }));

// Підключення плагіна розмов
bot.use(conversations());

// Функція для валідації числа в діапазоні
const validateInput = (text, min, max) => {
  const num = parseInt(text, 10);
  return !isNaN(num) && num >= min && num <= max;
};

// Конверсейшн для реєстрації
async function register(conversation, ctx) {
  // 1. Стать
  const genderKeyboard = new InlineKeyboard()
    .text('Чоловік', 'male')
    .text('Жінка', 'female');
  await ctx.reply('Оберіть вашу стать:', { reply_markup: genderKeyboard });
  
  const queryCtx = await conversation.waitForCallbackQuery(['male', 'female']);
  const gender = queryCtx.callbackQuery.data === 'male' ? 'Чоловік' : 'Жінка';
  await queryCtx.answerCallbackQuery();
  await queryCtx.reply(`Ви обрали: ${gender}`);

  // 2. Вік
  await ctx.reply('Введіть ваш вік (від 10 до 100 років):');
  let age;
  while (true) {
    const { message } = await conversation.wait();
    if (message?.text && validateInput(message.text, 10, 100)) {
      age = parseInt(message.text, 10);
      break;
    }
    await ctx.reply('Некоректне значення. Введіть число від 10 до 100:');
  }

  // 3. Зріст
  await ctx.reply('Введіть ваш зріст у см (від 100 до 250):');
  let height;
  while (true) {
    const { message } = await conversation.wait();
    if (message?.text && validateInput(message.text, 100, 250)) {
      height = parseInt(message.text, 10);
      break;
    }
    await ctx.reply('Некоректне значення. Введіть число від 100 до 250:');
  }

  // 4. Вага
  await ctx.reply('Введіть вашу вагу у кг (від 30 до 300):');
  let weight;
  while (true) {
    const { message } = await conversation.wait();
    if (message?.text && validateInput(message.text, 30, 300)) {
      weight = parseInt(message.text, 10);
      break;
    }
    await ctx.reply('Некоректне значення. Введіть число від 30 до 300:');
  }

  // 5. Рівень активності
  const activityKeyboard = new InlineKeyboard()
    .text('Мінімальна', '1.2').row()
    .text('Низька (1-3 тренування)', '1.375').row()
    .text('Середня (3-5 тренувань)', '1.55').row()
    .text('Висока (6-7 тренувань)', '1.725').row()
    .text('Дуже висока (важка робота)', '1.9');
  
  await ctx.reply('Оберіть ваш рівень активності:', { reply_markup: activityKeyboard });
  
  const activityQueryCtx = await conversation.waitForCallbackQuery(['1.2', '1.375', '1.55', '1.725', '1.9']);
  const activityMultiplier = parseFloat(activityQueryCtx.callbackQuery.data);
  const activityLevel = activityQueryCtx.callbackQuery.data;
  await activityQueryCtx.answerCallbackQuery();

  // 6. Розрахунки (Міффлін-Сан Жеор)
  let bmr;
  if (gender === 'Чоловік') {
    bmr = 10 * weight + 6.25 * height - 5 * age + 5;
  } else {
    bmr = 10 * weight + 6.25 * height - 5 * age - 161;
  }
  
  const tdee = Math.round(bmr * activityMultiplier);
  bmr = Math.round(bmr);

  // Збереження в сесію через conversation.external
  await conversation.external((ctx) => {
    ctx.session.userProfile = {
      gender,
      age,
      height,
      weight,
      activityLevel,
      bmr,
      tdee
    };
  });

  await ctx.reply(`✅ Реєстрація завершена!\nВи можете переглянути свій профіль за допомогою команди /my_profile`);
}

// Реєстрація розмови
bot.use(createConversation(register));

// Команда /start
bot.command('start', (ctx) => {
  ctx.reply('Привіт! Я — твій персональний помічник з розрахунку калорій.\nДля початку роботи введіть /register, щоб заповнити дані.');
});

// Команда /register
bot.command('register', async (ctx) => {
  await ctx.conversation.enter('register');
});

// Команда /my_profile
bot.command('my_profile', (ctx) => {
  const profile = ctx.session.userProfile;
  if (!profile) {
    return ctx.reply('Ваш профіль порожній. Будь ласка, спочатку пройдіть реєстрацію /register');
  }

  const activityLabels = {
    '1.2': 'Мінімальна (сидячий спосіб життя)',
    '1.375': 'Низька (легкі тренування 1-3 рази на тиждень)',
    '1.55': 'Середня (тренування 3-5 разів на тиждень)',
    '1.725': 'Висока (інтенсивні тренування 6-7 разів на тиждень)',
    '1.9': 'Дуже висока (важка фізична праця)'
  };

  const message = `📋 *Ваш профіль:*\n\n` +
    `👤 Стать: ${profile.gender}\n` +
    `🎂 Вік: ${profile.age} років\n` +
    `📏 Зріст: ${profile.height} см\n` +
    `⚖️ Вага: ${profile.weight} кг\n` +
    `🏃 Активність: ${activityLabels[profile.activityLevel]}\n\n` +
    `🔥 *BMR (Базовий обмін речовин):* ${profile.bmr} ккал\n` +
    `🚀 *TDEE (Добова витрата калорій):* ${profile.tdee} ккал`;

  ctx.reply(message, { parse_mode: 'Markdown' });
});

// Команда /help
bot.command('help', (ctx) => {
  ctx.reply('Доступні команди:\n/start - Почати роботу\n/register - Заповнити дані профілю\n/my_profile - Показати мої дані та розрахунки\n/help - Список команд\n/info - Про бота');
});

// Команда /info
bot.command('info', (ctx) => {
  ctx.reply('ℹ️ Інформація про бота:\n🔹 Версія: 1.2.0\n🔹 Функції: Розрахунок BMR та TDEE\n🔹 Алгоритм: Формула Міффліна-Сан Жеора.');
});

// Відповідь на інші повідомлення
bot.on('message:text', (ctx) => {
  const text = ctx.message.text.toLowerCase();
  
  if (text.includes('hello') || text.includes('привіт')) {
    return ctx.reply('Привіт! 👋 Я твій помічник. Чим можу допомогти?\nСпробуй /register або /my_profile.');
  }

  if (text === 'help') {
    return ctx.reply('Схоже, ти шукаєш допомогу. Використовуй команду /help, щоб побачити всі доступні команди. 💡');
  }

  const randomResponses = [
    `Я отримав твоє повідомлення: "${ctx.message.text}". Цікаво! 🤔`,
    'Хмм, цікава думка! До речі, ти вже заповнив свій профіль у /register?',
    'Я поки що тільки вчуся, але твої слова записав. 😉',
    'Ого, звучить серйозно! Може краще порахуємо калорії? /register',
    'Дякую за повідомлення! Якщо хочеш дізнатися свій BMR, просто напиши /register.'
  ];

  const randomIndex = Math.floor(Math.random() * randomResponses.length);
  ctx.reply(randomResponses[randomIndex]);
});

// Обробка помилок
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Помилка під час обробки оновлення ${ctx.update.update_id}:`);
  const e = err.error;
  console.error("Помилка:", e);
});

// Запуск бота
bot.start();
console.log('Бот запущений...');