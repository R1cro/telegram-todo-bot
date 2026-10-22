import {
  getExpensesSummary,
  getCategoryExpenses,
  getUserExpenses,
  getProductPopularity,
  getRecentReceipts,
  type PeriodFilter,
  type Receipt,
  type TodoItem,
} from './db.js';

export type ExpensesTab = 'overview' | 'categories' | 'products' | 'users' | 'receipts';

/**
 * Escapes characters that have special meaning in Telegram HTML formatting.
 */
export function escapeHtml(text: string | null | undefined): string {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Strips leading emoji/icons from category names so they can be rendered as clean text badges.
 * e.g. "🍫 Сладости и снеки" -> "Сладости и снеки"
 */
export function cleanCategoryName(raw?: string | null): string {
  if (!raw) return 'Прочее';
  return raw.replace(/^[^\p{L}\p{N}]+\s*/u, '').trim() || 'Прочее';
}

/**
 * Maps a category name to a clean, distinct colored circle marker badge.
 * Provides visual color categorization without requiring Telegram code blocks (which act as copy buttons).
 */
export function getCategoryColorMarker(rawCat?: string | null): string {
  const clean = cleanCategoryName(rawCat).toLowerCase();

  if (clean.includes('овощ') || clean.includes('фрукт') || clean.includes('ягод') || clean.includes('зелен')) {
    return '🟢';
  }
  if (
    clean.includes('молоч') ||
    clean.includes('творог') ||
    clean.includes('йогурт') ||
    clean.includes('кефир') ||
    clean.includes('масло слив') ||
    clean.includes('сырок') ||
    clean.includes('сметан')
  ) {
    return '🟣';
  }
  if (
    clean.includes('мяс') ||
    clean.includes('птиц') ||
    clean.includes('рыб') ||
    clean.includes('колбас') ||
    clean.includes('сосиск') ||
    clean.includes('индейк') ||
    clean.includes('говядин') ||
    clean.includes('фарш')
  ) {
    return '🔴';
  }
  if (
    clean.includes('хлеб') ||
    clean.includes('выпечк') ||
    clean.includes('булоч') ||
    clean.includes('круассан') ||
    clean.includes('пирог') ||
    clean.includes('тост') ||
    clean.includes('батон')
  ) {
    return '🟡';
  }
  if (
    clean.includes('сладост') ||
    clean.includes('снек') ||
    clean.includes('шоколад') ||
    clean.includes('конфет') ||
    clean.includes('торт') ||
    clean.includes('десерт') ||
    clean.includes('чипс') ||
    clean.includes('вафл') ||
    clean.includes('печень')
  ) {
    return '🟠';
  }
  if (
    clean.includes('бакале') ||
    clean.includes('сыр') ||
    clean.includes('круп') ||
    clean.includes('макарон') ||
    clean.includes('консерв') ||
    clean.includes('рис') ||
    clean.includes('гречк')
  ) {
    return '🟤';
  }
  if (
    clean.includes('напит') ||
    clean.includes('сок') ||
    clean.includes('вод') ||
    clean.includes('чай') ||
    clean.includes('кофе') ||
    clean.includes('пиво') ||
    clean.includes('морс')
  ) {
    return '🔵';
  }
  if (clean.includes('хим') || clean.includes('гигиен') || clean.includes('мыл') || clean.includes('бытов')) {
    return '🔘';
  }
  if (clean.includes('аптек') || clean.includes('лекарств')) {
    return '🔴';
  }
  return '⚪';
}

/**
 * Formats category as a clean colored badge in brackets, e.g. "🟠 [Сладости и снеки]".
 * Visually distinguishes categories with real color while avoiding Telegram's copy-to-clipboard code tag.
 */
export function formatCategoryBadge(rawCat?: string | null): string {
  const clean = cleanCategoryName(rawCat);
  const marker = getCategoryColorMarker(clean);
  return `${marker} [${escapeHtml(clean)}]`;
}

export function parsePeriodDays(period: PeriodFilter): number {
  switch (period) {
    case '7d':
      return 7;
    case '14d':
      return 14;
    case '30d':
    default:
      return 30;
  }
}

export function formatMoney(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return rounded.toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }) + ' ₽';
}

export function formatProgressBar(percentage: number, width: number = 8): string {
  const clamped = Math.max(0, Math.min(100, percentage));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

export async function renderExpensesDashboard(
  chatId: number,
  period: PeriodFilter = '7d',
  tab: ExpensesTab = 'overview',
  isGroup: boolean = false
): Promise<string> {
  const days = parsePeriodDays(period);
  const periodLabel = days === 7 ? '7 дней' : days === 14 ? '14 дней' : 'месяц (30 дней)';

  if (tab === 'categories') {
    const [summary, categories] = await Promise.all([
      getExpensesSummary(chatId, days),
      getCategoryExpenses(chatId, days),
    ]);

    let text = `🏷 <b>Категории расходов за ${periodLabel}:</b>\n\n`;
    text += `💰 <b>Всего потрачено:</b> ${formatMoney(summary.totalAmount)} (чеков: <b>${summary.receiptsCount}</b>)\n\n`;

    if (categories.length === 0) {
      text += `<i>За этот период пока нет записанных покупок.</i>\n\n` +
        `📸 Отправьте фото кассового чека в чат, чтобы внести данные!`;
      return text;
    }

    for (const cat of categories) {
      const bar = formatProgressBar(cat.percentage, 8);
      const catBadge = formatCategoryBadge(cat.category);
      text += `<b>${catBadge}</b>\n`;
      text += `└ <b>${formatMoney(cat.totalSpent)}</b>  [${bar}] <b>${cat.percentage}%</b> (поз: ${cat.itemsCount})\n\n`;
    }

    return text.trim();
  }

  if (tab === 'products') {
    const [summary, popularity] = await Promise.all([
      getExpensesSummary(chatId, days),
      getProductPopularity(chatId, days, 10),
    ]);

    let text = `🏆 <b>Топ товаров и расходов за ${periodLabel}:</b>\n\n`;
    text += `💰 <b>Сумма покупок:</b> <b>${formatMoney(summary.totalAmount)}</b>\n\n`;

    if (popularity.length === 0) {
      text += `<i>За выбранный период товары ещё не зарегистрированы.</i>\n\n` +
        `📸 Отправьте фото кассового чека в чат для анализа трат.`;
      return text;
    }

    text += `Показаны наиболее затратные и часто покупаемые позиции:\n\n`;

    popularity.forEach((p, index) => {
      const num = index + 1;
      const qtyStr = p.totalQuantity > 1 ? ` (кол-во: <b>${p.totalQuantity}</b>)` : '';
      const buyStr = p.buyCount > 1 ? ` • покупок: ${p.buyCount}` : '';
      const catBadge = formatCategoryBadge(p.category);
      text += `<b>${num}. ${escapeHtml(p.name)}</b>\n`;
      text += `   └ <b>${formatMoney(p.totalSpent)}</b>${qtyStr}${buyStr} • ${catBadge}\n\n`;
    });

    return text.trim();
  }

  if (tab === 'users') {
    const [summary, users] = await Promise.all([
      getExpensesSummary(chatId, days),
      getUserExpenses(chatId, days),
    ]);

    let text = `👥 <b>Распределение расходов за ${periodLabel}:</b>\n\n`;
    text += `💰 <b>Общие траты группы:</b> <b>${formatMoney(summary.totalAmount)}</b>\n`;
    text += `🧾 <b>Всего чеков:</b> ${summary.receiptsCount}\n\n`;

    if (users.length === 0) {
      text += `<i>За выбранный период нет данных о покупках.</i>`;
      return text;
    }

    for (const u of users) {
      const bar = formatProgressBar(u.percentage, 8);
      text += `👤 <b>${escapeHtml(u.user_name)}</b>\n`;
      text += `└ <b>${formatMoney(u.totalSpent)}</b>  [${bar}] <b>${u.percentage}%</b> (чеков: ${u.receiptsCount})\n\n`;
    }

    return text.trim();
  }

  if (tab === 'receipts') {
    const receipts = await getRecentReceipts(chatId, 6);
    let text = `🧾 <b>Последние зарегистрированные чеки:</b>\n\n`;

    if (receipts.length === 0) {
      text += `<i>История чеков пока пуста.</i>\n\n` +
        `📸 Просто отправьте фотографию чека в чат, чтобы сохранить его в базу!`;
      return text;
    }

    receipts.forEach((r, i) => {
      const dateStr = new Date(r.receipt_date).toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });
      const storeStr = r.store_name ? ` «<b>${escapeHtml(r.store_name)}</b>»` : '';
      const userStr = isGroup && r.user_name ? ` (👤 ${escapeHtml(r.user_name)})` : '';

      text += `<b>${i + 1}. Чек #${r.id}</b>${storeStr} от ${dateStr}${userStr}\n`;
      text += `   └ Сумма: <b>${formatMoney(r.total_amount)}</b> (позиций: ${r.items_count})\n\n`;
    });

    text += `💡 <i>Чтобы открыть детали чека, нажмите кнопку с его номером ниже.</i>`;
    return text.trim();
  }

  // Default: Overview tab
  const [summary, categories, users, topProducts] = await Promise.all([
    getExpensesSummary(chatId, days),
    getCategoryExpenses(chatId, days),
    isGroup ? getUserExpenses(chatId, days) : Promise.resolve([]),
    getProductPopularity(chatId, days, 3),
  ]);

  let text = `📊 <b>Дэшборд расходов (${periodLabel}):</b>\n\n`;
  text += `💰 <b>Всего потрачено:</b> <b>${formatMoney(summary.totalAmount)}</b>\n\n`;
  text += `🧾 <b>Чеков обработано:</b> <b>${summary.receiptsCount}</b>\n\n`;
  text += `📈 <b>Средний чек:</b> <b>${formatMoney(summary.averageReceipt)}</b>\n\n`;
  text += `🛍 <b>Куплено товаров:</b> <b>${summary.itemsCount} шт.</b>\n\n`;

  if (summary.receiptsCount === 0) {
    text += `<i>За выбранный период пока нет чеков.</i>\n\n` +
      `📸 <b>Как добавить чек:</b>\n` +
      `Просто отправьте фотографию чека в чат боту — он автоматически распознает товары, цены, подсчитает итог и отметит купленное в списке покупок!`;
    return text;
  }

  // Top categories preview
  if (categories.length > 0) {
    text += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `🏷 <b>Основные категории трат:</b>\n\n`;
    const previewCats = categories.slice(0, 4);
    for (const c of previewCats) {
      const bar = formatProgressBar(c.percentage, 8);
      const catBadge = formatCategoryBadge(c.category);
      text += `• ${catBadge}: <b>${formatMoney(c.totalSpent)}</b> [${bar} ${c.percentage}%]\n\n`;
    }
    if (categories.length > 4) {
      text += `<i>... и ещё ${categories.length - 4} категорий (см. вкладку «🏷 Категории»)</i>\n\n`;
    }
  }

  // Top products preview
  if (topProducts.length > 0) {
    text += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `🏆 <b>Топ покупок по сумме:</b>\n\n`;
    topProducts.forEach((p, idx) => {
      const catBadge = formatCategoryBadge(p.category);
      text += `${idx + 1}. <b>${escapeHtml(p.name)}</b> — <b>${formatMoney(p.totalSpent)}</b> • ${catBadge}\n\n`;
    });
  }

  // Group members preview
  if (isGroup && users.length > 0) {
    text += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `👥 <b>Вклад участников:</b>\n\n`;
    for (const u of users) {
      text += `• <b>${escapeHtml(u.user_name)}</b>: ${formatMoney(u.totalSpent)} (${u.percentage}%)\n\n`;
    }
  }

  text += `💡 <i>Переключайте период (7, 14, 30 дней) и разделы кнопками ниже 👇</i>`;
  return text.trim();
}

/**
 * Renders the detailed digital card for a specific saved receipt.
 * Clean layout without icons in the header summary and with color badge styling for categories.
 */
export function renderReceiptCard(
  receipt: Receipt,
  matchedItems: TodoItem[] = [],
  isGroup: boolean = false
): string {
  const dateFormatted = new Date(receipt.receipt_date).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const storeHeader = receipt.store_name ? ` «<b>${escapeHtml(receipt.store_name)}</b>»` : '';

  let card = `✅ <b>Чек успешно распознан и сохранён в базу!</b>\n\n`;
  card += `<b>Чек #${receipt.id}</b>${storeHeader}\n`;
  card += `<b>Дата:</b> ${dateFormatted}\n`;
  card += `<b>Итоговая сумма:</b> <b>${formatMoney(receipt.total_amount)}</b>\n`;
  card += `<b>Всего позиций:</b> ${receipt.items_count}\n`;
  if (isGroup && receipt.user_name) {
    card += `<b>Оплатил(а):</b> ${escapeHtml(receipt.user_name)}\n`;
  }
  card += `\n`;

  card += `<b>Распознанные товары и цены:</b>\n`;
  const items = receipt.items || [];
  if (items.length > 0) {
    items.forEach((it, idx) => {
      const num = idx + 1;
      const qtyStr = it.quantity && it.quantity !== 1 ? ` (${it.quantity} шт.)` : '';
      const unitPriceStr = it.unit_price && it.quantity > 1 ? ` [по ${formatMoney(it.unit_price)}]` : '';
      const badge = formatCategoryBadge(it.category);
      card += `<b>${num}. ${escapeHtml(it.name)}</b>${qtyStr}\n`;
      card += `   └ <b>${formatMoney(it.total_price)}</b>${unitPriceStr} • ${badge}\n\n`;
    });
  } else {
    card += `<i>Позиции сохранены в базе чеков.</i>\n`;
  }

  if (matchedItems.length > 0) {
    card += `\n✅ <b>Вычеркнуто из списка покупок (${matchedItems.length}):</b>\n`;
    for (const m of matchedItems) {
      card += `• <s>${escapeHtml(m.text)}</s>\n`;
    }
  }

  card += `\n<i>Данные внесены в ваш профиль и учтены в статистике трат (/expenses, /receipts).</i>`;
  return card.trim();
}

/**
 * Renders a list of receipts for the /receipts command.
 */
export function renderReceiptsList(receipts: Receipt[], isGroup: boolean = false): string {
  if (receipts.length === 0) {
    return `🧾 <b>История чеков пуста.</b>\n\n` +
      `📸 Чтобы внести чек в базу, просто пришлите его фотографию в этот чат!\n` +
      `Бот распознает позиции, подсчитает итог и добавит в аналитику трат.`;
  }

  let text = `🧾 <b>Зарегистрированные чеки покупок:</b>\n\n`;
  receipts.forEach((r, idx) => {
    const num = idx + 1;
    const dateFormatted = new Date(r.receipt_date).toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
    const storeStr = r.store_name ? ` «<b>${escapeHtml(r.store_name)}</b>»` : '';
    const userStr = isGroup && r.user_name ? ` • 👤 ${escapeHtml(r.user_name)}` : '';

    text += `<b>${num}. Чек #${r.id}</b>${storeStr} (${dateFormatted})\n`;
    text += `   └ Сумма: <b>${formatMoney(r.total_amount)}</b> (товаров: ${r.items_count})${userStr}\n\n`;
  });

  text += `💡 <i>Нажмите кнопку с номером чека ниже для детального просмотра списка товаров или используйте команду <code>/receipt [номер]</code>.</i>`;
  return text.trim();
}
