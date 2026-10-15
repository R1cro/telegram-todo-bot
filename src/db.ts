import { createClient, type Client } from '@libsql/client';
import { config } from './config.js';

export type Category = 'shopping' | 'task';

export interface TodoItem {
  id: number;
  chat_id: number;
  category: Category;
  text: string;
  is_done: boolean;
  created_at: string;
}

export interface UserSettings {
  chat_id: number;
  username?: string;
  first_name?: string;
  active_category: Category;
  last_list_message_id?: number | null;
  created_at: string;
}

export interface CategoryStats {
  shoppingTotal: number;
  shoppingDone: number;
  taskTotal: number;
  taskDone: number;
}

let dbClient: Client | null = null;

export function getDb(): Client {
  if (!dbClient) {
    dbClient = createClient({
      url: config.dbPath,
    });
  }
  return dbClient;
}

export async function initDatabase(): Promise<void> {
  const db = getDb();

  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      active_category TEXT NOT NULL DEFAULT 'shopping',
      last_list_message_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Мягкая миграция: добавляем колонку в существующую базу, если её ещё нет
  try {
    await db.execute(`ALTER TABLE users ADD COLUMN last_list_message_id INTEGER`);
  } catch {
    // Колонка уже существует
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      text TEXT NOT NULL,
      is_done INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_items_chat_category ON items(chat_id, category)
  `);
}

export async function getOrCreateUser(
  chatId: number,
  username?: string,
  firstName?: string
): Promise<UserSettings> {
  const db = getDb();

  const existing = await db.execute({
    sql: 'SELECT * FROM users WHERE chat_id = ?',
    args: [chatId],
  });

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    return {
      chat_id: Number(row.chat_id),
      username: row.username ? String(row.username) : undefined,
      first_name: row.first_name ? String(row.first_name) : undefined,
      active_category: (row.active_category as Category) || 'shopping',
      last_list_message_id: row.last_list_message_id !== null && row.last_list_message_id !== undefined
        ? Number(row.last_list_message_id)
        : null,
      created_at: String(row.created_at),
    };
  }

  await db.execute({
    sql: 'INSERT INTO users (chat_id, username, first_name, active_category) VALUES (?, ?, ?, ?)',
    args: [chatId, username ?? null, firstName ?? null, 'shopping'],
  });

  return {
    chat_id: chatId,
    username,
    first_name: firstName,
    active_category: 'shopping',
    last_list_message_id: null,
    created_at: new Date().toISOString(),
  };
}

export async function setUserCategory(chatId: number, category: Category): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: 'UPDATE users SET active_category = ? WHERE chat_id = ?',
    args: [category, chatId],
  });
}

export async function setLastListMessageId(chatId: number, messageId: number | null): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: 'UPDATE users SET last_list_message_id = ? WHERE chat_id = ?',
    args: [messageId, chatId],
  });
}

export async function getLastListMessageId(chatId: number): Promise<number | null> {
  const db = getDb();
  const res = await db.execute({
    sql: 'SELECT last_list_message_id FROM users WHERE chat_id = ?',
    args: [chatId],
  });
  if (res.rows.length === 0 || res.rows[0].last_list_message_id === null || res.rows[0].last_list_message_id === undefined) {
    return null;
  }
  return Number(res.rows[0].last_list_message_id);
}

export async function isListCompleted(chatId: number, category: Category): Promise<boolean> {
  const items = await getItems(chatId, category);
  if (items.length === 0) return true;
  return items.every((i) => i.is_done);
}

export async function addItems(
  chatId: number,
  items: Array<{ category: Category; text: string }>
): Promise<number[]> {
  const db = getDb();
  const addedIds: number[] = [];

  for (const item of items) {
    const cleanText = item.text.trim();
    if (!cleanText) continue;

    const res = await db.execute({
      sql: 'INSERT INTO items (chat_id, category, text, is_done) VALUES (?, ?, ?, 0)',
      args: [chatId, item.category, cleanText],
    });
    if (res.lastInsertRowid !== undefined) {
      addedIds.push(Number(res.lastInsertRowid));
    }
  }

  return addedIds;
}

export async function getItems(chatId: number, category: Category): Promise<TodoItem[]> {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT * FROM items 
          WHERE chat_id = ? AND category = ? 
          ORDER BY is_done ASC, id DESC`,
    args: [chatId, category],
  });

  return res.rows.map((row) => ({
    id: Number(row.id),
    chat_id: Number(row.chat_id),
    category: row.category as Category,
    text: String(row.text),
    is_done: Boolean(row.is_done),
    created_at: String(row.created_at),
  }));
}

export async function toggleItemDone(chatId: number, itemId: number): Promise<boolean | null> {
  const db = getDb();
  const existing = await db.execute({
    sql: 'SELECT is_done FROM items WHERE id = ? AND chat_id = ?',
    args: [itemId, chatId],
  });

  if (existing.rows.length === 0) return null;

  const currentStatus = Number(existing.rows[0].is_done);
  const newStatus = currentStatus === 1 ? 0 : 1;

  await db.execute({
    sql: 'UPDATE items SET is_done = ? WHERE id = ? AND chat_id = ?',
    args: [newStatus, itemId, chatId],
  });

  return newStatus === 1;
}

export async function deleteItem(chatId: number, itemId: number): Promise<boolean> {
  const db = getDb();
  const res = await db.execute({
    sql: 'DELETE FROM items WHERE id = ? AND chat_id = ?',
    args: [itemId, chatId],
  });
  return res.rowsAffected > 0;
}

export async function clearCompletedItems(chatId: number, category: Category): Promise<number> {
  const db = getDb();
  const res = await db.execute({
    sql: 'DELETE FROM items WHERE chat_id = ? AND category = ? AND is_done = 1',
    args: [chatId, category],
  });
  return res.rowsAffected;
}

export async function clearAllCategoryItems(chatId: number, category: Category): Promise<number> {
  const db = getDb();
  const res = await db.execute({
    sql: 'DELETE FROM items WHERE chat_id = ? AND category = ?',
    args: [chatId, category],
  });
  return res.rowsAffected;
}

export async function getStats(chatId: number): Promise<CategoryStats> {
  const db = getDb();
  const res = await db.execute({
    sql: `
      SELECT 
        category,
        COUNT(*) as total,
        SUM(CASE WHEN is_done = 1 THEN 1 ELSE 0 END) as done
      FROM items
      WHERE chat_id = ?
      GROUP BY category
    `,
    args: [chatId],
  });

  const stats: CategoryStats = {
    shoppingTotal: 0,
    shoppingDone: 0,
    taskTotal: 0,
    taskDone: 0,
  };

  for (const row of res.rows) {
    const cat = String(row.category);
    const total = Number(row.total);
    const done = Number(row.done || 0);

    if (cat === 'shopping') {
      stats.shoppingTotal = total;
      stats.shoppingDone = done;
    } else if (cat === 'task') {
      stats.taskTotal = total;
      stats.taskDone = done;
    }
  }

  return stats;
}
