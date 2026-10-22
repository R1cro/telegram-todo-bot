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
      text += `<b>${cat.category}</b>\n`;
      text += `└ ${formatMoney(cat.totalSpent)}  [<code>${bar}</code>] <b>${cat.percentage}%</b> (поз: ${cat.itemsCount})\n\n`;
    }

    return text.trim();
  }

  if (tab === 'products') {
    const [summary, popularity] = await Promise.all([
      getExpensesSummary(chatId, days),
      getProductPopularity(chatId, days, 10),
    ]);

    let text = `🏆 <b>Топ товаров и расходов за ${periodLabel}:</b>\n\n`;
    text += `💰 <b>Сумма покупок:</b> ${formatMoney(summary.totalAmount)}\n\n`;

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
      text += `<b>${num}. ${p.name}</b>\n`;
      text += `   └ <b>${formatMoney(p.totalSpent)}</b>${qtyStr}${buyStr}\n`;
      text += `   └ <i>${p.category}</i>\n\n`;
    });

    return text.trim();
  }

  if (tab === 'users') {
    const [summary, users] = await Promise.all([
      getExpensesSummary(chatId, days),
      getUserExpenses(chatId, days),
    ]);

    let text = `👥 <b>Распределение расходов за ${periodLabel}:</b>\n\n`;
    text += `💰 <b>Общие траты группы:</b> ${formatMoney(summary.totalAmount)}\n`;
    text += `🧾 <b>Всего чеков:</b> ${summary.receiptsCount}\n\n`;

    if (users.length === 0) {
      text += `<i>За выбранный период нет данных о покупках.</i>`;
      return text;
    }

    for (const u of users) {
      const bar = formatProgressBar(u.percentage, 8);
      text += `👤 <b>${u.user_name}</b>\n`;
      text += `└ ${formatMoney(u.totalSpent)}  [<code>${bar}</code>] <b>${u.percentage}%</b> (чеков: ${u.receiptsCount})\n\n`;
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
      const storeStr = r.store_name ? ` «<b>${r.store_name}</b>»` : '';
      const userStr = isGroup && r.user_name ? ` (👤 ${r.user_name})` : '';

      text += `<b>${i + 1}. Чек #${r.id}</b>${storeStr} от ${dateStr}${userStr}\n`;
      text += `   └ Сумма: <b>${formatMoney(r.total_amount)}</b> (позиций: ${r.items_count})\n\n`;
    });

    text += `💡 <i>Чтобы удалить чек, используйте кнопку с его номером ниже.</i>`;
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
  text += `💰 <b>Всего потрачено:</b> <code>${formatMoney(summary.totalAmount)}</code>\n`;
  text += `🧾 <b>Чеков обработано:</b> <b>${summary.receiptsCount}</b>\n`;
  text += `📈 <b>Средний чек:</b> <b>${formatMoney(summary.averageReceipt)}</b>\n`;
  text += `🛍 <b>Куплено товаров:</b> <b>${summary.itemsCount} шт.</b>\n\n`;

  if (summary.receiptsCount === 0) {
    text += `<i>За выбранный период пока нет чеков.</i>\n\n` +
      `📸 <b>Как добавить чек:</b>\n` +
      `Просто отправьте фотографию чека в чат боту — он автоматически распознает товары, цены, подсчитает итог и отметит купленное в списке покупок!`;
    return text;
  }

  // Top categories preview
  if (categories.length > 0) {
    text += `━━━━━━━━━━━━━━━━━━━━\n`;
    text += `🏷 <b>Основные категории трат:</b>\n`;
    const previewCats = categories.slice(0, 4);
    for (const c of previewCats) {
      const bar = formatProgressBar(c.percentage, 8);
      text += `• ${c.category}: <b>${formatMoney(c.totalSpent)}</b> [<code>${bar}</code> ${c.percentage}%]\n`;
    }
    if (categories.length > 4) {
      text += `<i>... и ещё ${categories.length - 4} категорий (см. вкладку «🏷 Категории»)</i>\n`;
    }
    text += `\n`;
  }

  // Top products preview
  if (topProducts.length > 0) {
    text += `━━━━━━━━━━━━━━━━━━━━\n`;
    text += `🏆 <b>Топ покупок по сумме:</b>\n`;
    topProducts.forEach((p, idx) => {
      text += `${idx + 1}. <b>${p.name}</b> — ${formatMoney(p.totalSpent)} (${p.totalQuantity} шт.)\n`;
    });
    text += `\n`;
  }

  // Group members preview
  if (isGroup && users.length > 0) {
    text += `━━━━━━━━━━━━━━━━━━━━\n`;
    text += `👥 <b>Вклад участников:</b>\n`;
    for (const u of users) {
      text += `• <b>${u.user_name}</b>: ${formatMoney(u.totalSpent)} (${u.percentage}%)\n`;
    }
    text += `\n`;
  }

  text += `💡 <i>Переключайте период (7, 14, 30 дней) и разделы кнопками ниже 👇</i>`;
  return text.trim();
}

/**
 * Renders the detailed digital card for a specific saved receipt.
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
  const storeHeader = receipt.store_name ? ` «<b>${receipt.store_name}</b>»` : '';

  let card = `🧾 <b>Чек #${receipt.id} сохранён в базу!</b>\n\n`;
  card += `🏪 <b>Магазин:</b>${storeHeader}\n`;
  card += `📅 <b>Дата:</b> ${dateFormatted}\n`;
  card += `💰 <b>Итоговая сумма:</b> <code>${formatMoney(receipt.total_amount)}</code>\n`;
  card += `🛍 <b>Всего позиций:</b> <b>${receipt.items_count}</b>\n`;
  if (isGroup && receipt.user_name) {
    card += `👤 <b>Оплатил(а):</b> ${receipt.user_name}\n`;
  }
  card += `\n`;

  card += `📋 <b>Распознанные товары и цены:</b>\n`;
  const items = receipt.items || [];
  if (items.length > 0) {
    items.forEach((it, idx) => {
      const num = idx + 1;
      const qtyStr = it.quantity && it.quantity !== 1 ? ` (${it.quantity} шт.)` : '';
      const unitPriceStr = it.unit_price && it.quantity > 1 ? ` [по ${formatMoney(it.unit_price)}]` : '';
      card += `<b>${num}. ${it.name}</b>${qtyStr}\n`;
      card += `   └ <b>${formatMoney(it.total_price)}</b>${unitPriceStr} • <i>${it.category}</i>\n`;
    });
  } else {
    card += `<i>Позиции сохранены в базе чеков.</i>\n`;
  }

  if (matchedItems.length > 0) {
    card += `\n✅ <b>Вычеркнуто из списка покупок (${matchedItems.length}):</b>\n`;
    for (const m of matchedItems) {
      card += `• <s>${m.text}</s>\n`;
    }
  }

  card += `\n💾 <i>Данные внесены в ваш профиль и учтены в статистике трат (/expenses).</i>`;
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
    const storeStr = r.store_name ? ` «<b>${r.store_name}</b>»` : '';
    const userStr = isGroup && r.user_name ? ` • 👤 ${r.user_name}` : '';

    text += `<b>${num}. Чек #${r.id}</b>${storeStr} (${dateFormatted})\n`;
    text += `   └ Сумма: <b>${formatMoney(r.total_amount)}</b> (товаров: ${r.items_count})${userStr}\n\n`;
  });

  text += `💡 <i>Нажмите кнопку с номером чека ниже для детального просмотра списка товаров или используйте команду <code>/receipt [номер]</code>.</i>`;
  return text.trim();
}
