import { createClient, type Client } from '@libsql/client';
import { config } from './config.js';

export type Category = 'shopping' | 'task';
export type ListStatus = 'active' | 'closed';

export interface TodoList {
  id: number;
  chat_id: number;
  status: ListStatus;
  last_message_id?: number | null;
  created_at: string;
  closed_at?: string | null;
}

export interface TodoItem {
  id: number;
  list_id: number;
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

/**
 * Initializes database tables and indices.
 */
export async function initDatabase(): Promise<void> {
  const db = getDb();

  // Users / Chats table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      active_category TEXT NOT NULL DEFAULT 'shopping',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Explicit TodoList entity table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS todo_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      last_message_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_at DATETIME
    )
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_todo_lists_chat_status ON todo_lists(chat_id, status)
  `);

  // Items table linked to specific todo_list
  await db.execute(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER,
      chat_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      text TEXT NOT NULL,
      is_done INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Soft migration in case items table existed without list_id
  try {
    await db.execute(`ALTER TABLE items ADD COLUMN list_id INTEGER`);
  } catch {
    // Column already exists
  }

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_items_list_category ON items(list_id, category)
  `);
}

/**
 * Retrieves or registers user/chat preferences.
 */
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
    created_at: new Date().toISOString(),
  };
}

/**
 * Sets active UI category (shopping or task) for user/chat.
 */
export async function setUserCategory(chatId: number, category: Category): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: 'UPDATE users SET active_category = ? WHERE chat_id = ?',
    args: [category, chatId],
  });
}

/**
 * Finds current active list entity for a chat.
 */
export async function getActiveList(chatId: number): Promise<TodoList | null> {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT * FROM todo_lists 
          WHERE chat_id = ? AND status = 'active' 
          ORDER BY id DESC LIMIT 1`,
    args: [chatId],
  });

  if (res.rows.length === 0) return null;

  const row = res.rows[0];
  return {
    id: Number(row.id),
    chat_id: Number(row.chat_id),
    status: row.status as ListStatus,
    last_message_id: row.last_message_id !== null && row.last_message_id !== undefined
      ? Number(row.last_message_id)
      : null,
    created_at: String(row.created_at),
    closed_at: row.closed_at ? String(row.closed_at) : null,
  };
}

/**
 * Gets the current active list or creates a brand new active list entity.
 */
export async function getOrCreateActiveList(chatId: number): Promise<TodoList> {
  const active = await getActiveList(chatId);
  if (active) return active;

  const db = getDb();
  const res = await db.execute({
    sql: `INSERT INTO todo_lists (chat_id, status) VALUES (?, 'active')`,
    args: [chatId],
  });

  const newListId = Number(res.lastInsertRowid);
  return {
    id: newListId,
    chat_id: chatId,
    status: 'active',
    last_message_id: null,
    created_at: new Date().toISOString(),
    closed_at: null,
  };
}

/**
 * Closes the active list entity for a chat.
 */
export async function closeActiveList(chatId: number): Promise<TodoList | null> {
  const active = await getActiveList(chatId);
  if (!active) return null;

  const db = getDb();
  await db.execute({
    sql: `UPDATE todo_lists SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = ?`,
    args: [active.id],
  });

  return {
    ...active,
    status: 'closed',
    closed_at: new Date().toISOString(),
  };
}

/**
 * Updates Telegram message id associated with the list card.
 */
export async function setListLastMessageId(listId: number, messageId: number | null): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: 'UPDATE todo_lists SET last_message_id = ? WHERE id = ?',
    args: [messageId, listId],
  });
}

/**
 * Appends items to an active list entity.
 */
export async function addItems(
  listId: number,
  chatId: number,
  items: Array<{ category: Category; text: string }>
): Promise<number[]> {
  const db = getDb();
  const addedIds: number[] = [];

  for (const item of items) {
    const cleanText = item.text.trim();
    if (!cleanText) continue;

    const res = await db.execute({
      sql: 'INSERT INTO items (list_id, chat_id, category, text, is_done) VALUES (?, ?, ?, ?, 0)',
      args: [listId, chatId, item.category, cleanText],
    });
    if (res.lastInsertRowid !== undefined) {
      addedIds.push(Number(res.lastInsertRowid));
    }
  }

  return addedIds;
}

/**
 * Gets items belonging to a specific list and category.
 */
export async function getListItems(listId: number, category: Category): Promise<TodoItem[]> {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT * FROM items 
          WHERE list_id = ? AND category = ? 
          ORDER BY is_done ASC, id ASC`,
    args: [listId, category],
  });

  return res.rows.map((row) => ({
    id: Number(row.id),
    list_id: Number(row.list_id),
    chat_id: Number(row.chat_id),
    category: row.category as Category,
    text: String(row.text),
    is_done: Boolean(row.is_done),
    created_at: String(row.created_at),
  }));
}

/**
 * Toggles an item between done and undone.
 */
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

/**
 * Removes completed items from a specific list entity.
 */
export async function clearCompletedFromList(listId: number, category: Category): Promise<number> {
  const db = getDb();
  const res = await db.execute({
    sql: 'DELETE FROM items WHERE list_id = ? AND category = ? AND is_done = 1',
    args: [listId, category],
  });
  return res.rowsAffected;
}

/**
 * Removes all items of a category from a specific list entity.
 */
export async function clearCategoryFromList(listId: number, category: Category): Promise<number> {
  const db = getDb();
  const res = await db.execute({
    sql: 'DELETE FROM items WHERE list_id = ? AND category = ?',
    args: [listId, category],
  });
  return res.rowsAffected;
}

/**
 * Calculates item counts and completion stats for a list entity.
 */
export async function getListStats(listId: number): Promise<CategoryStats> {
  const db = getDb();
  const res = await db.execute({
    sql: `
      SELECT 
        category,
        COUNT(*) as total,
        SUM(CASE WHEN is_done = 1 THEN 1 ELSE 0 END) as done
      FROM items
      WHERE list_id = ?
      GROUP BY category
    `,
    args: [listId],
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
