import { createClient, type Client } from '@libsql/client';
import fs from 'fs';
import path from 'path';
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
  quantity: number;
  price?: number | null;
  barcode?: string | null;
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
  shoppingTotalPrice: number;
  shoppingBoughtPrice: number;
}

export interface ProductCatalogEntry {
  barcode: string;
  name: string;
  price?: number | null;
  currency?: string;
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
    await db.execute(`ALTER TABLE items ADD COLUMN price REAL`);
  } catch {
    // Column already exists
  }

  try {
    await db.execute(`ALTER TABLE items ADD COLUMN barcode TEXT`);
  } catch {
    // Column already exists
  }

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_items_list_category ON items(list_id, category)
  `);

  // Product catalog for barcodes, known names and prices
  await db.execute(`
    CREATE TABLE IF NOT EXISTS products_catalog (
      barcode TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL,
      currency TEXT DEFAULT 'RUB',
      category TEXT DEFAULT 'shopping',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await seedStarterCatalogIfEmpty(db);
}

/**
 * Automatically seeds initial common retail barcodes if the catalog table is empty.
 */
async function seedStarterCatalogIfEmpty(db: Client): Promise<void> {
  try {
    const countRes = await db.execute('SELECT COUNT(*) as cnt FROM products_catalog');
    const count = Number(countRes.rows[0]?.cnt || 0);
    if (count > 0) return;

    const possiblePaths = [
      path.resolve(process.cwd(), 'assets', 'starter_catalog.json'),
      path.resolve(process.cwd(), 'data', 'starter_catalog.json'),
    ];

    let catalogPath: string | null = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        catalogPath = p;
        break;
      }
    }

    if (!catalogPath) return;

    const raw = fs.readFileSync(catalogPath, 'utf-8');
    const items = JSON.parse(raw);
    if (!Array.isArray(items) || items.length === 0) return;

    const statements = items
      .filter((item: any) => item && item.barcode && item.name)
      .map((item: any) => ({
        sql: `INSERT OR IGNORE INTO products_catalog (barcode, name, price, category) VALUES (?, ?, ?, ?)`,
        args: [
          String(item.barcode).trim(),
          String(item.name).trim(),
          typeof item.price === 'number' && item.price > 0 ? item.price : null,
          String(item.category || 'shopping'),
        ],
      }));

    if (statements.length > 0) {
      await db.batch(statements, 'write');
      console.log(`[db] Pre-seeded ${statements.length} products into local barcode catalog.`);
    }
  } catch (err) {
    console.warn('[db] Failed to pre-seed starter catalog:', err);
  }
}

/**
 * Clears the local product catalog table.
 * If reseed is true, resets it back to the initial starter catalog.
 */
export async function clearProductCatalog(reseed: boolean = false): Promise<{ deleted: number; reseeded: number }> {
  const db = getDb();
  const countRes = await db.execute('SELECT COUNT(*) as cnt FROM products_catalog');
  const deleted = Number(countRes.rows[0]?.cnt || 0);

  await db.execute('DELETE FROM products_catalog');

  let reseeded = 0;
  if (reseed) {
    await seedStarterCatalogIfEmpty(db);
    const afterRes = await db.execute('SELECT COUNT(*) as cnt FROM products_catalog');
    reseeded = Number(afterRes.rows[0]?.cnt || 0);
  }

  return { deleted, reseeded };
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
 * Gets Telegram message IDs of all lists for a chat, optionally excluding a specific list.
 */
export async function getAllListMessageIds(chatId: number, excludeListId?: number): Promise<number[]> {
  const db = getDb();
  const sql = excludeListId
    ? 'SELECT last_message_id FROM todo_lists WHERE chat_id = ? AND last_message_id IS NOT NULL AND id != ?'
    : 'SELECT last_message_id FROM todo_lists WHERE chat_id = ? AND last_message_id IS NOT NULL';
  const args = excludeListId ? [chatId, excludeListId] : [chatId];

  const res = await db.execute({ sql, args });
  return res.rows
    .map((r) => Number(r.last_message_id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

/**
 * Clears message IDs for lists once they have been deleted from Telegram.
 */
export async function clearListMessageIds(chatId: number, messageIds: number[]): Promise<void> {
  if (messageIds.length === 0) return;
  const db = getDb();
  const placeholders = messageIds.map(() => '?').join(',');
  await db.execute({
    sql: `UPDATE todo_lists SET last_message_id = NULL WHERE chat_id = ? AND last_message_id IN (${placeholders})`,
    args: [chatId, ...messageIds],
  });
}

/**
 * Appends items to an active list entity.
 */
export async function addItems(
  listId: number,
  chatId: number,
  items: Array<{
    category: Category;
    text: string;
    quantity?: number;
    price?: number | null;
    barcode?: string | null;
  }>
): Promise<number[]> {
  const db = getDb();
  const addedIds: number[] = [];

  for (const item of items) {
    const cleanText = item.text.trim();
    if (!cleanText) continue;
    const qty = Math.max(1, Math.round(item.quantity ?? 1));
    const price = item.price !== undefined ? item.price : null;
    const barcode = item.barcode ? item.barcode.trim() : null;

    const res = await db.execute({
      sql: 'INSERT INTO items (list_id, chat_id, category, text, quantity, price, barcode, is_done) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
      args: [listId, chatId, item.category, cleanText, qty, price, barcode],
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
    price: row.price !== null && row.price !== undefined ? Number(row.price) : null,
    barcode: row.barcode ? String(row.barcode) : null,
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
    price: row.price !== null && row.price !== undefined ? Number(row.price) : null,
    barcode: row.barcode ? String(row.barcode) : null,
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

  // If item has a barcode, update catalog so it is remembered permanently
  try {
    const item = await getItemById(chatId, itemId);
    if (item?.barcode) {
      await saveOrUpdateProductCatalog(item.barcode, clean, item.price);
    }
  } catch {}

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
        SUM(CASE WHEN is_done = 1 THEN 1 ELSE 0 END) as done,
        SUM(COALESCE(price, 0) * quantity) as total_price,
        SUM(CASE WHEN is_done = 1 THEN (COALESCE(price, 0) * quantity) ELSE 0 END) as bought_price
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
    shoppingTotalPrice: 0,
    shoppingBoughtPrice: 0,
  };

  for (const row of res.rows) {
    const cat = String(row.category);
    const total = Number(row.total);
    const done = Number(row.done || 0);
    const totalPrice = Math.round(Number(row.total_price || 0) * 100) / 100;
    const boughtPrice = Math.round(Number(row.bought_price || 0) * 100) / 100;

    if (cat === 'shopping') {
      stats.shoppingTotal = total;
      stats.shoppingDone = done;
      stats.shoppingTotalPrice = totalPrice;
      stats.shoppingBoughtPrice = boughtPrice;
    } else if (cat === 'task') {
      stats.taskTotal = total;
      stats.taskDone = done;
    }
  }

  return stats;
}

/**
 * Sets or updates the price and barcode of an item.
 */
export async function setItemPriceAndBarcode(
  chatId: number,
  itemId: number,
  price: number | null,
  barcode?: string | null
): Promise<boolean> {
  const db = getDb();
  const res = await db.execute({
    sql: 'UPDATE items SET price = ?, barcode = COALESCE(?, barcode) WHERE id = ? AND chat_id = ?',
    args: [price, barcode ?? null, itemId, chatId],
  });
  return res.rowsAffected > 0;
}

/**
 * Retrieves a product entry from the local catalog by barcode.
 */
export async function getProductByBarcode(barcode: string): Promise<ProductCatalogEntry | null> {
  const db = getDb();
  const res = await db.execute({
    sql: 'SELECT * FROM products_catalog WHERE barcode = ?',
    args: [barcode.trim()],
  });
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    barcode: String(row.barcode),
    name: String(row.name),
    price: row.price !== null && row.price !== undefined ? Number(row.price) : null,
    currency: String(row.currency || 'RUB'),
  };
}

/**
 * Saves or updates a product in the local catalog.
 */
export async function saveOrUpdateProductCatalog(
  barcode: string,
  name: string,
  price?: number | null
): Promise<void> {
  const db = getDb();
  const cleanBarcode = barcode.trim();
  const cleanName = name.trim();
  if (!cleanBarcode || !cleanName) return;

  await db.execute({
    sql: `INSERT INTO products_catalog (barcode, name, price, updated_at) 
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(barcode) DO UPDATE SET 
            name = excluded.name,
            price = COALESCE(excluded.price, products_catalog.price),
            updated_at = CURRENT_TIMESTAMP`,
    args: [cleanBarcode, cleanName, price ?? null],
  });
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
