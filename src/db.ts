import { createClient, type Client } from '@libsql/client';
import { config } from './config.js';

export type Category = 'shopping' | 'task';
export type ListStatus = 'active' | 'closed';

export interface TodoList {
  id: number;
  chat_id: number;
  status: ListStatus;
  last_message_id?: number | null;
  nav_message_id?: number | null;
  created_at: string;
  closed_at?: string | null;
}

export interface TodoItem {
  id: number;
  list_id: number;
  chat_id: number;
  category: Category;
  text: string;
  quantity: number;
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

export type PeriodFilter = '7d' | '14d' | '30d';

export interface ReceiptItemInput {
  name: string;
  category: string;
  quantity: number;
  unit_price?: number | null;
  total_price: number;
}

export interface ReceiptItem extends ReceiptItemInput {
  id: number;
  receipt_id: number;
  chat_id: number;
  user_id: number;
  created_at: string;
}

export interface Receipt {
  id: number;
  chat_id: number;
  user_id: number;
  user_name?: string | null;
  store_name?: string | null;
  receipt_date: string;
  total_amount: number;
  items_count: number;
  raw_json?: string | null;
  created_at: string;
  items?: ReceiptItem[];
}

export interface ExpensesSummary {
  periodDays: number;
  totalAmount: number;
  receiptsCount: number;
  itemsCount: number;
  averageReceipt: number;
}

export interface CategoryExpense {
  category: string;
  totalSpent: number;
  itemsCount: number;
  percentage: number;
}

export interface UserExpenseShare {
  user_id: number;
  user_name: string;
  totalSpent: number;
  receiptsCount: number;
  percentage: number;
}

export interface ProductPopularity {
  name: string;
  category: string;
  buyCount: number;
  totalQuantity: number;
  totalSpent: number;
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
    CREATE TABLE IF NOT EXISTS bot_activity_users (
      user_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS bot_group_memberships (
      chat_id INTEGER PRIMARY KEY,
      title TEXT,
      username TEXT,
      status TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

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
      quantity INTEGER NOT NULL DEFAULT 1,
      is_done INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Soft migrations for existing databases
  try {
    await db.execute(`ALTER TABLE items ADD COLUMN list_id INTEGER`);
  } catch {
    // Column already exists
  }

  try {
    await db.execute(`ALTER TABLE items ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1`);
  } catch {
    // Column already exists
  }

  try {
    await db.execute(`ALTER TABLE todo_lists ADD COLUMN nav_message_id INTEGER`);
  } catch {
    // Column already exists
  }

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_items_list_category ON items(list_id, category)
  `);

  // Receipts entity table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      user_name TEXT,
      store_name TEXT,
      receipt_date DATETIME NOT NULL,
      total_amount REAL NOT NULL,
      items_count INTEGER NOT NULL DEFAULT 0,
      raw_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_receipts_chat_date ON receipts(chat_id, receipt_date)
  `);

  // Receipt items table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS receipt_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Прочее',
      quantity REAL NOT NULL DEFAULT 1,
      unit_price REAL,
      total_price REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_receipt_items_receipt_id ON receipt_items(receipt_id)
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_receipt_items_chat_created ON receipt_items(chat_id, created_at)
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_receipt_items_name ON receipt_items(name)
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
    nav_message_id: row.nav_message_id !== null && row.nav_message_id !== undefined
      ? Number(row.nav_message_id)
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
    nav_message_id: null,
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
 * Updates Telegram message IDs associated with the list card and navigation block.
 */
export async function setListMessageIds(
  listId: number,
  cardMessageId: number | null,
  navMessageId: number | null = null
): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: 'UPDATE todo_lists SET last_message_id = ?, nav_message_id = ? WHERE id = ?',
    args: [cardMessageId, navMessageId, listId],
  });
}

/**
 * Updates Telegram message id associated with the list card (backward compatibility).
 */
export async function setListLastMessageId(listId: number, messageId: number | null): Promise<void> {
  return setListMessageIds(listId, messageId, null);
}

/**
 * Gets Telegram message IDs of all lists for a chat, optionally excluding a specific list.
 */
export async function getAllListMessageIds(chatId: number, excludeListId?: number): Promise<number[]> {
  const db = getDb();
  const sql = excludeListId
    ? 'SELECT last_message_id, nav_message_id FROM todo_lists WHERE chat_id = ? AND id != ?'
    : 'SELECT last_message_id, nav_message_id FROM todo_lists WHERE chat_id = ?';
  const args = excludeListId ? [chatId, excludeListId] : [chatId];

  const res = await db.execute({ sql, args });
  const ids: number[] = [];
  for (const r of res.rows) {
    const cardId = Number(r.last_message_id);
    if (Number.isSafeInteger(cardId) && cardId > 0) ids.push(cardId);
    const navId = Number(r.nav_message_id);
    if (Number.isSafeInteger(navId) && navId > 0) ids.push(navId);
  }
  return ids;
}

/**
 * Clears message IDs for lists once they have been deleted from Telegram.
 */
export async function clearListMessageIds(chatId: number, messageIds: number[]): Promise<void> {
  if (messageIds.length === 0) return;
  const db = getDb();
  const placeholders = messageIds.map(() => '?').join(',');
  await db.execute({
    sql: `UPDATE todo_lists SET 
            last_message_id = CASE WHEN last_message_id IN (${placeholders}) THEN NULL ELSE last_message_id END,
            nav_message_id = CASE WHEN nav_message_id IN (${placeholders}) THEN NULL ELSE nav_message_id END
          WHERE chat_id = ?`,
    args: [...messageIds, ...messageIds, chatId],
  });
}

/**
 * Appends items to an active list entity.
 */
export async function addItems(
  listId: number,
  chatId: number,
  items: Array<{ category: Category; text: string; quantity?: number }>
): Promise<number[]> {
  const db = getDb();
  const addedIds: number[] = [];

  for (const item of items) {
    const cleanText = item.text.trim();
    if (!cleanText) continue;
    const qty = Math.max(1, Math.round(item.quantity ?? 1));

    const res = await db.execute({
      sql: 'INSERT INTO items (list_id, chat_id, category, text, quantity, is_done) VALUES (?, ?, ?, ?, ?, 0)',
      args: [listId, chatId, item.category, cleanText, qty],
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
    quantity: Math.max(1, Number(row.quantity || 1)),
    is_done: Boolean(row.is_done),
    created_at: String(row.created_at),
  }));
}

/**
 * Retrieves a single item by id and chat id.
 */
export async function getItemById(chatId: number, itemId: number): Promise<TodoItem | null> {
  const db = getDb();
  const res = await db.execute({
    sql: 'SELECT * FROM items WHERE id = ? AND chat_id = ?',
    args: [itemId, chatId],
  });
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    id: Number(row.id),
    list_id: Number(row.list_id),
    chat_id: Number(row.chat_id),
    category: row.category as Category,
    text: String(row.text),
    quantity: Math.max(1, Number(row.quantity || 1)),
    is_done: Boolean(row.is_done),
    created_at: String(row.created_at),
  };
}

/**
 * Updates item quantity by adding delta (e.g. +1 or -1). Minimum quantity is 1.
 */
export async function updateItemQuantity(
  chatId: number,
  itemId: number,
  delta: number
): Promise<number | null> {
  const db = getDb();
  const existing = await db.execute({
    sql: 'SELECT quantity FROM items WHERE id = ? AND chat_id = ?',
    args: [itemId, chatId],
  });

  if (existing.rows.length === 0) return null;

  const currentQty = Math.max(1, Number(existing.rows[0].quantity || 1));
  const newQty = Math.max(1, currentQty + delta);

  await db.execute({
    sql: 'UPDATE items SET quantity = ? WHERE id = ? AND chat_id = ?',
    args: [newQty, itemId, chatId],
  });

  return newQty;
}

/**
 * Updates the text description of an existing item.
 */
export async function updateItemText(
  chatId: number,
  itemId: number,
  newText: string
): Promise<boolean> {
  const db = getDb();
  const clean = newText.trim();
  if (!clean) return false;

  const res = await db.execute({
    sql: 'UPDATE items SET text = ? WHERE id = ? AND chat_id = ?',
    args: [clean, itemId, chatId],
  });

  return res.rowsAffected > 0;
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
 * Deletes a single item by id and chat id.
 */
export async function deleteItem(chatId: number, itemId: number): Promise<boolean> {
  const db = getDb();
  const res = await db.execute({
    sql: 'DELETE FROM items WHERE id = ? AND chat_id = ?',
    args: [itemId, chatId],
  });
  return res.rowsAffected > 0;
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

export async function recordBotUserActivity(userId: number, username?: string, firstName?: string): Promise<void> {
  await getDb().execute({
    sql: `INSERT INTO bot_activity_users (user_id, username, first_name, last_seen_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id) DO UPDATE SET
            username = excluded.username,
            first_name = excluded.first_name,
            last_seen_at = CURRENT_TIMESTAMP`,
    args: [userId, username ?? null, firstName ?? null],
  });
}

export async function recordBotGroupMembership(
  chatId: number, title: string, username: string | undefined, status: string
): Promise<void> {
  await getDb().execute({
    sql: `INSERT INTO bot_group_memberships (chat_id, title, username, status, updated_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(chat_id) DO UPDATE SET
            title = excluded.title, username = excluded.username,
            status = excluded.status, updated_at = CURRENT_TIMESTAMP`,
    args: [chatId, title, username ?? null, status],
  });
}

export async function getBotAuditData() {
  const db = getDb();
  const [users, knownGroups, membershipEvents] = await Promise.all([
    db.execute('SELECT user_id, username, first_name, last_seen_at FROM bot_activity_users ORDER BY last_seen_at DESC'),
    db.execute('SELECT chat_id, first_name FROM users WHERE chat_id < 0 ORDER BY chat_id'),
    db.execute('SELECT chat_id, title, username, status, updated_at FROM bot_group_memberships ORDER BY updated_at DESC'),
  ]);
  return { users: users.rows, knownGroups: knownGroups.rows, membershipEvents: membershipEvents.rows };
}

// ---------------- RECEIPT & EXPENSE ANALYTICS ---------------- //

export async function addReceipt(
  chatId: number,
  userId: number,
  userName: string | undefined,
  storeName: string | undefined,
  receiptDate: string,
  totalAmount: number,
  items: ReceiptItemInput[],
  rawJson?: string
): Promise<Receipt> {
  const db = getDb();

  const receiptResult = await db.execute({
    sql: `INSERT INTO receipts (chat_id, user_id, user_name, store_name, receipt_date, total_amount, items_count, raw_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      chatId,
      userId,
      userName ?? null,
      storeName ?? null,
      receiptDate,
      totalAmount,
      items.length,
      rawJson ?? null,
    ],
  });

  const receiptId = Number(receiptResult.lastInsertRowid);
  const insertedItems: ReceiptItem[] = [];

  for (const it of items) {
    const itemResult = await db.execute({
      sql: `INSERT INTO receipt_items (receipt_id, chat_id, user_id, name, category, quantity, unit_price, total_price)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        receiptId,
        chatId,
        userId,
        it.name,
        it.category || 'Прочее',
        it.quantity || 1,
        it.unit_price ?? null,
        it.total_price,
      ],
    });

    insertedItems.push({
      id: Number(itemResult.lastInsertRowid),
      receipt_id: receiptId,
      chat_id: chatId,
      user_id: userId,
      name: it.name,
      category: it.category || 'Прочее',
      quantity: it.quantity || 1,
      unit_price: it.unit_price ?? null,
      total_price: it.total_price,
      created_at: new Date().toISOString(),
    });
  }

  return {
    id: receiptId,
    chat_id: chatId,
    user_id: userId,
    user_name: userName,
    store_name: storeName,
    receipt_date: receiptDate,
    total_amount: totalAmount,
    items_count: items.length,
    raw_json: rawJson,
    created_at: new Date().toISOString(),
    items: insertedItems,
  };
}

export async function getReceiptById(receiptId: number): Promise<Receipt | null> {
  const db = getDb();
  const res = await db.execute({
    sql: 'SELECT * FROM receipts WHERE id = ?',
    args: [receiptId],
  });
  if (res.rows.length === 0) return null;
  const row = res.rows[0];

  const itemsRes = await db.execute({
    sql: 'SELECT * FROM receipt_items WHERE receipt_id = ? ORDER BY id ASC',
    args: [receiptId],
  });

  return {
    id: Number(row.id),
    chat_id: Number(row.chat_id),
    user_id: Number(row.user_id),
    user_name: row.user_name ? String(row.user_name) : null,
    store_name: row.store_name ? String(row.store_name) : null,
    receipt_date: String(row.receipt_date),
    total_amount: Number(row.total_amount),
    items_count: Number(row.items_count),
    raw_json: row.raw_json ? String(row.raw_json) : null,
    created_at: String(row.created_at),
    items: itemsRes.rows.map((r) => ({
      id: Number(r.id),
      receipt_id: Number(r.receipt_id),
      chat_id: Number(r.chat_id),
      user_id: Number(r.user_id),
      name: String(r.name),
      category: String(r.category),
      quantity: Number(r.quantity),
      unit_price: r.unit_price !== null && r.unit_price !== undefined ? Number(r.unit_price) : null,
      total_price: Number(r.total_price),
      created_at: String(r.created_at),
    })),
  };
}

export async function deleteReceipt(chatId: number, receiptId: number): Promise<boolean> {
  const db = getDb();
  await db.execute({
    sql: 'DELETE FROM receipt_items WHERE chat_id = ? AND receipt_id = ?',
    args: [chatId, receiptId],
  });
  const res = await db.execute({
    sql: 'DELETE FROM receipts WHERE chat_id = ? AND id = ?',
    args: [chatId, receiptId],
  });
  return res.rowsAffected > 0;
}

export async function getRecentReceipts(chatId: number, limit: number = 5): Promise<Receipt[]> {
  const db = getDb();
  const res = await db.execute({
    sql: 'SELECT * FROM receipts WHERE chat_id = ? ORDER BY receipt_date DESC, id DESC LIMIT ?',
    args: [chatId, limit],
  });

  return res.rows.map((row) => ({
    id: Number(row.id),
    chat_id: Number(row.chat_id),
    user_id: Number(row.user_id),
    user_name: row.user_name ? String(row.user_name) : null,
    store_name: row.store_name ? String(row.store_name) : null,
    receipt_date: String(row.receipt_date),
    total_amount: Number(row.total_amount),
    items_count: Number(row.items_count),
    raw_json: row.raw_json ? String(row.raw_json) : null,
    created_at: String(row.created_at),
  }));
}

export async function getExpensesSummary(chatId: number, days: number = 7): Promise<ExpensesSummary> {
  const db = getDb();
  const daysOffset = `-${Math.max(1, days)} days`;

  const res = await db.execute({
    sql: `SELECT 
            COALESCE(SUM(total_amount), 0) AS total_amount,
            COUNT(id) AS receipts_count,
            COALESCE(SUM(items_count), 0) AS items_count
          FROM receipts 
          WHERE chat_id = ? 
            AND (receipt_date >= datetime('now', ?) OR created_at >= datetime('now', ?))`,
    args: [chatId, daysOffset, daysOffset],
  });

  const row = res.rows[0];
  const totalAmount = Number(row?.total_amount || 0);
  const receiptsCount = Number(row?.receipts_count || 0);
  const itemsCount = Number(row?.items_count || 0);
  const averageReceipt = receiptsCount > 0 ? Math.round((totalAmount / receiptsCount) * 100) / 100 : 0;

  return {
    periodDays: days,
    totalAmount,
    receiptsCount,
    itemsCount,
    averageReceipt,
  };
}

export async function getCategoryExpenses(chatId: number, days: number = 30): Promise<CategoryExpense[]> {
  const db = getDb();
  const daysOffset = `-${Math.max(1, days)} days`;

  const totalRes = await db.execute({
    sql: `SELECT COALESCE(SUM(total_price), 0) AS total_spent 
          FROM receipt_items 
          WHERE chat_id = ? AND created_at >= datetime('now', ?)`,
    args: [chatId, daysOffset],
  });
  const overallTotal = Number(totalRes.rows[0]?.total_spent || 0);

  const res = await db.execute({
    sql: `SELECT 
            category,
            SUM(total_price) AS total_spent,
            COUNT(id) AS items_count
          FROM receipt_items
          WHERE chat_id = ? AND created_at >= datetime('now', ?)
          GROUP BY category
          ORDER BY total_spent DESC`,
    args: [chatId, daysOffset],
  });

  return res.rows.map((row) => {
    const totalSpent = Number(row.total_spent || 0);
    const itemsCount = Number(row.items_count || 0);
    const percentage = overallTotal > 0 ? Math.round((totalSpent / overallTotal) * 100) : 0;
    return {
      category: String(row.category || 'Прочее'),
      totalSpent,
      itemsCount,
      percentage,
    };
  });
}

export async function getUserExpenses(chatId: number, days: number = 30): Promise<UserExpenseShare[]> {
  const db = getDb();
  const daysOffset = `-${Math.max(1, days)} days`;

  const totalRes = await db.execute({
    sql: `SELECT COALESCE(SUM(total_amount), 0) AS grand_total 
          FROM receipts 
          WHERE chat_id = ? AND (receipt_date >= datetime('now', ?) OR created_at >= datetime('now', ?))`,
    args: [chatId, daysOffset, daysOffset],
  });
  const grandTotal = Number(totalRes.rows[0]?.grand_total || 0);

  const res = await db.execute({
    sql: `SELECT 
            user_id,
            user_name,
            SUM(total_amount) AS total_spent,
            COUNT(id) AS receipts_count
          FROM receipts
          WHERE chat_id = ? AND (receipt_date >= datetime('now', ?) OR created_at >= datetime('now', ?))
          GROUP BY user_id
          ORDER BY total_spent DESC`,
    args: [chatId, daysOffset, daysOffset],
  });

  return res.rows.map((row) => {
    const totalSpent = Number(row.total_spent || 0);
    const percentage = grandTotal > 0 ? Math.round((totalSpent / grandTotal) * 100) : 0;
    return {
      user_id: Number(row.user_id),
      user_name: row.user_name ? String(row.user_name) : `ID ${row.user_id}`,
      totalSpent,
      receiptsCount: Number(row.receipts_count || 0),
      percentage,
    };
  });
}

export async function getProductPopularity(
  chatId: number,
  days: number = 30,
  limit: number = 10
): Promise<ProductPopularity[]> {
  const db = getDb();
  const daysOffset = `-${Math.max(1, days)} days`;

  const res = await db.execute({
    sql: `SELECT 
            name,
            category,
            COUNT(id) AS buy_count,
            SUM(quantity) AS total_qty,
            SUM(total_price) AS total_spent
          FROM receipt_items
          WHERE chat_id = ? AND created_at >= datetime('now', ?)
          GROUP BY LOWER(TRIM(name))
          ORDER BY total_spent DESC, buy_count DESC
          LIMIT ?`,
    args: [chatId, daysOffset, limit],
  });

  return res.rows.map((row) => ({
    name: String(row.name),
    category: String(row.category || 'Прочее'),
    buyCount: Number(row.buy_count || 0),
    totalQuantity: Number(row.total_qty || 0),
    totalSpent: Math.round(Number(row.total_spent || 0) * 100) / 100,
  }));
}

function extractSignificantTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w));
}

export async function markMatchingShoppingItemsDone(
  chatId: number,
  listId: number,
  boughtItemNames: string[]
): Promise<TodoItem[]> {
  const db = getDb();
  const activeItems = await getListItems(listId, 'shopping');
  const uncompleted = activeItems.filter((i) => !i.is_done);
  if (uncompleted.length === 0 || boughtItemNames.length === 0) return [];

  const matchedItems: TodoItem[] = [];

  for (const item of uncompleted) {
    const cleanItemName = item.text.toLowerCase().trim();
    const itemTokens = extractSignificantTokens(item.text);

    const isMatched = boughtItemNames.some((bought) => {
      const b = bought.toLowerCase().trim();
      if (b === cleanItemName) return true;
      if (cleanItemName.length >= 4 && b.includes(cleanItemName)) return true;
      if (b.length >= 4 && cleanItemName.includes(b)) return true;

      // Token / Stem matching (e.g. "молоко" matches "Молоко Домик в деревне")
      const boughtTokens = extractSignificantTokens(bought);
      return itemTokens.some((iTok) =>
        boughtTokens.some((bTok) => {
          if (iTok === bTok) return true;
          // Substring/prefix root match for words of length >= 4 (e.g. "яйц" for "яйца" / "яйцо")
          const minLen = Math.min(iTok.length, bTok.length);
          if (minLen >= 4 && (iTok.startsWith(bTok.slice(0, 4)) || bTok.startsWith(iTok.slice(0, 4)))) {
            return true;
          }
          return false;
        })
      );
    });

    if (isMatched) {
      await db.execute({
        sql: 'UPDATE items SET is_done = 1 WHERE chat_id = ? AND id = ?',
        args: [chatId, item.id],
      });
      matchedItems.push({
        ...item,
        is_done: true,
      });
    }
  }

  return matchedItems;
}
