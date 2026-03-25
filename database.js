import Database from 'better-sqlite3';

const db = new Database('database.db');

db.pragma('foreign_keys = ON');

export function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      sex TEXT,
      age INTEGER,
      height INTEGER,
      weight INTEGER,
      activity_level TEXT,
      bmr INTEGER,
      tdee INTEGER
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS meals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      raw_text TEXT,
      calories_estimated INTEGER,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )
  `);

  // Migration: Add 'notes' column if it doesn't exist
  const mealsInfo = db.prepare("PRAGMA table_info(meals)").all();
  const hasNotes = mealsInfo.some(col => col.name === 'notes');
  if (!hasNotes) {
    try {
      db.exec('ALTER TABLE meals ADD COLUMN notes TEXT');
      console.log('Column "notes" added to "meals" table.');
    } catch (e) {
      console.error('Error adding column "notes":', e.message);
    }
  }

  console.log('✅ База даних ініціалізована.');
}

export default db;
