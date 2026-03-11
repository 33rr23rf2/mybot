import 'dotenv/config';
import { Bot } from 'grammy';

const bot = new Bot(process.env.BOT_TOKEN);

// Команда /start
bot.command('start', (ctx) => {
  ctx.reply('Привіт! Я — твій перший бот. Я можу відповідати на команди та повідомлення.');
});

// Команда /help
bot.command('help', (ctx) => {
  ctx.reply('Доступні команди:\n/start - Почати роботу\n/help - Список команд\n/info - Інформація про бота');
});

// Команда /info
bot.command('info', (ctx) => {
  ctx.reply('ℹ️ Інформація про бота:\n🔹 Версія: 1.0.0\n🔹 Платформа: Node.js (grammY)\n🔹 Призначення: Навчальний проект для створення Telegram-ботів.');
});

// Відповідь на інші повідомлення
bot.on('message:text', (ctx) => {
  const text = ctx.message.text;
  ctx.reply(`Я отримав твоє повідомлення: ${text}`);
});

// Запуск бота
bot.start();
console.log('Бот запущений...');