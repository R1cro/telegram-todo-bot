import { Bot, Context, InlineKeyboard } from 'grammy';
import { config, validateConfig } from './config.js';
import {
  initDatabase,
  getOrCreateUser,
  setUserCategory,
  getOrCreateActiveList,
  closeActiveList,
  setListLastMessageId,
  getAllListMessageIds,
  clearListMessageIds,
  addItems,
  getListItems,
  getItemById,
  updateItemQuantity,
  updateItemText,
  toggleItemDone,
  deleteItem,
  clearCompletedFromList,
  clearCategoryFromList,
  getListStats,
  setItemPriceAndBarcode,
  getProductByBarcode,
  recordBotUserActivity,
  recordBotGroupMembership,
  getBotAuditData,
  type Category,
  type TodoItem,
  type CategoryStats,
} from './db.js';
import { parseMessage, parseVoiceWithGemini, extractQuantity } from './parser.js';
import {
  recognizeBarcodeAndProductFromImage,
  processScannedProduct,
} from './barcode.js';
import {
  buildListKeyboard,
  buildManageListKeyboard,
  buildManageItemKeyboard,
  buildConfirmClearKeyboard,
  buildConfirmFinishKeyboard,
  buildCancelEditKeyboard,
} from './keyboards.js';

validateConfig();

export const bot = new Bot(config.botToken);

// Keep an audit of user accounts that have sent an update the bot can see.
bot.use(async (ctx, next) => {
  if (ctx.from) {
    try {
      await recordBotUserActivity(ctx.from.id, ctx.from.username, ctx.from.first_name);
    } catch (error) {
      console.warn('Could not record bot user activity:', error);
    }
  }
  await next();
});

// Telegram does not expose a method to enumerate all groups. Record membership
// changes from now on so the owner can see known current and former groups.
bot.on('my_chat_member', async (ctx) => {
  const update = ctx.myChatMember;
  const chat = update.chat;
  if (chat.type !== 'group' && chat.type !== 'supergroup') return;
  await recordBotGroupMembership(
    chat.id,
    chat.title || '(без названия)',
    chat.username,
    update.new_chat_member.status,
  );

  // Automatically leave if not an authorized group
  if (!config.allowedChatIds.includes(chat.id) && update.new_chat_member.status !== 'left') {
    try {
      await ctx.leaveChat();
    } catch {}
  }
});

// Enforce chat and user access restrictions
bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return next();

  // Allow /myid for anyone in private chat to discover their Telegram ID
  const text = ctx.message?.text?.trim() || '';
  if (text.startsWith('/myid')) {
    return next();
  }

  // Allow /audit for administrators in private chat
  if (text.startsWith('/audit') && ctx.from && config.adminUserIds.includes(ctx.from.id)) {
    return next();
  }

  // Check if group is authorized
  if (config.allowedChatIds.includes(chatId)) {
    // If a user whitelist is configured, restrict actions to authorized users
    if (config.allowedUserIds.length > 0) {
      const fromId = ctx.from?.id;
      const isAllowed = Boolean(
        fromId && (config.allowedUserIds.includes(fromId) || config.adminUserIds.includes(fromId))
      );

      if (!isAllowed) {
        if (ctx.callbackQuery) {
          await ctx.answerCallbackQuery({
            text: '⛔ У вас нет доступа к управлению этим ботом.',
            show_alert: true,
          });
          return;
        }

        // In group chats, silently ignore messages from non-whitelisted users
        return;
      }
    }

    return next();
  }

  // Reject unauthorized callback queries
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: '⛔ Этот бот работает исключительно в разрешённой группе.', show_alert: true });
    return;
  }

  // Automatically leave unauthorized groups
  if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
    try {
      await ctx.leaveChat();
    } catch {}
    return;
  }

  // Handle private chat messages
  if (ctx.chat?.type === 'private') {
    await ctx.reply('⛔ Этот бот работает исключительно в разрешённой группе.');
    return;
  }

  return;
});

bot.command('myid', async (ctx) => {
  if (!ctx.from) return;
  await ctx.reply(`Ваш Telegram ID: <code>${ctx.from.id}</code>`, { parse_mode: 'HTML' });
});

bot.command('audit', async (ctx) => {
  if (ctx.chat.type !== 'private' || !ctx.from || !config.adminUserIds.includes(ctx.from.id)) {
    await ctx.reply('Команда доступна владельцу бота в личном чате.');
    return;
  }

  const report = await getBotAuditData();
  const membershipById = new Map(report.membershipEvents.map((row) => [Number(row.chat_id), row]));
  const knownGroupIds = new Set(report.knownGroups.map((row) => Number(row.chat_id)));
  for (const row of report.membershipEvents) knownGroupIds.add(Number(row.chat_id));

  const lines = [
    '👤 Пользователи, чьи обновления бот получил с момента установки отчёта:',
    ...(report.users.length ? report.users.map((row) => {
      const name = [row.first_name, row.username ? `@${row.username}` : undefined].filter(Boolean).join(' ');
      return `• ${name || '(имя не задано)'} — ID ${row.user_id}; последнее обращение: ${row.last_seen_at}`;
    }) : ['Пока записей нет.']),
    '',
    '👥 Группы:',
    ...(knownGroupIds.size ? [...knownGroupIds].map((id) => {
      const event = membershipById.get(id);
      const known = report.knownGroups.find((row) => Number(row.chat_id) === id);
      const title = event?.title || known?.first_name || '(название неизвестно)';
      const status = event ? `статус ${event.status}, обновлено ${event.updated_at}` : 'есть в старых данных; текущий статус неизвестен';
      return `• ${title} — ID ${id}; ${status}`;
    }) : ['Пока групп не зафиксировано.']),
    '',
    'Примечание: список групп основан на сохранённых взаимодействиях и событиях членства. Telegram не предоставляет боту полный список групп; старые записи могут быть неполными или устаревшими.',
  ];

  let chunk = '';
  for (const line of lines) {
    const next = chunk ? `${chunk}\n${line}` : line;
    if (next.length > 3500) {
      await ctx.reply(chunk);
      chunk = line;
    } else {
      chunk = next;
    }
  }
  if (chunk) await ctx.reply(chunk);
});

interface PendingEdit {
  type?: 'text' | 'price';
  itemId: number;
  itemText: string;
  promptMsgId?: number;
}
const pendingEdits = new Map<number, PendingEdit>();

// Conversational chatter stop-words to ignore in group chats to avoid reacting to casual talk
const CHAT_STOP_WORDS = /^(привет|хай|ку|здравствуйте|добрый день|как дела|ок|окей|ok|хорошо|ладно|понял|понятно|пон|спасибо|спс|спасиб|благодарю|да|нет|неа|ага|я дома|я скоро|я выехал|я на месте|пока|доброе утро|спокойной ночи|отлично|лол|кек|хаха|ха-ха|круто|класс|ясно|точно|согласен|плюс|минус|\?|!|\.|\+|-)$/iu;

function isConversationalNoise(text: string): boolean {
  const clean = text.trim().toLowerCase().replace(/[.,!?;:()«»"']+/g, '').trim();
  return CHAT_STOP_WORDS.test(clean) || clean.length <= 1;
}

/**
 * Formats the HTML text representation of the current list with generous line spacing.
 */
function renderListMessage(
  category: Category,
  items: TodoItem[],
  stats?: CategoryStats,
  isGroup = false
): string {
  const categoryTitle = category === 'shopping'
    ? (isGroup ? '🛒 Общий список покупок' : '🛒 Список покупок')
    : (isGroup ? '📝 Общий список дел' : '📝 Список дел и задач');
  let header = `<b>${categoryTitle}</b>\n\n`;

  if (category === 'shopping' && stats && (stats.shoppingTotalPrice > 0 || stats.shoppingBoughtPrice > 0)) {
    const boughtPart = `💰 <b>В корзине: ${stats.shoppingBoughtPrice} ₽</b>`;
    const totalPart = stats.shoppingTotalPrice > stats.shoppingBoughtPrice
      ? ` <i>(из ${stats.shoppingTotalPrice} ₽)</i>`
      : '';
    header += `${boughtPart}${totalPart}\n\n`;
  }

  if (items.length === 0) {
    const hint = isGroup
      ? '💡 Отправьте сообщение, запишите голосовое или отправьте фото со штрихкодом товара!'
      : '💡 Отправьте текст с пунктами, запишите голосовое или отправьте фото со штрихкодом товара!';
    return `${header}<i>Список пока пуст.</i>\n\n${hint}`;
  }

  const activeItems = items.filter((i) => !i.is_done);
  const doneItems = items.filter((i) => i.is_done);

  let text = header;
  items.forEach((item, index) => {
    const icon = item.is_done ? '🟢' : '▫️';
    const num = `${index + 1}.`;
    const qtyText = item.quantity && item.quantity > 1
      ? ` — <b>${item.quantity} шт.</b>`
      : '';
    const priceText = item.price && item.price > 0
      ? ` • <b>${item.price} ₽</b>`
      : '';

    if (item.is_done) {
      text += `<s>${icon} ${num} ${item.text}${item.quantity && item.quantity > 1 ? ` (${item.quantity} шт.)` : ''}${priceText}</s>\n\n`;
    } else {
      text += `${icon} ${num} <b>${item.text}</b>${qtyText}${priceText}\n\n`;
    }
  });

  text += `Осталось: <b>${activeItems.length}</b> | Выполнено: <b>${doneItems.length}</b>\n\n`;
  if (category === 'shopping' && stats && stats.shoppingBoughtPrice > 0) {
    text += `Итого куплено на сумму: <b>${stats.shoppingBoughtPrice} ₽</b>\n\n`;
  }
  text += `<i>Управляйте пунктами, количеством и ценами кнопками ниже:</i>`;

  return text;
}

/**
 * Safely deletes an array of Telegram message IDs using deleteMessages with individual fallback.
 */
async function deleteMessagesSafe(ctx: Context, chatId: number, messageIds: number[]): Promise<number> {
  const uniqueIds = Array.from(new Set(messageIds.filter((id) => Number.isSafeInteger(id) && id > 0)));
  if (uniqueIds.length === 0) return 0;

  let deletedCount = 0;
  for (let i = 0; i < uniqueIds.length; i += 100) {
    const chunk = uniqueIds.slice(i, i + 100);
    try {
      await ctx.api.deleteMessages(chatId, chunk);
      deletedCount += chunk.length;
    } catch {
      // Fallback: delete individually in case some messages in the chunk cannot be deleted
      await Promise.allSettled(
        chunk.map(async (msgId) => {
          try {
            await ctx.api.deleteMessage(chatId, msgId);
            deletedCount++;
          } catch {}
        })
      );
    }
  }
  return deletedCount;
}

/**
 * Renders or updates the interactive list card for the current active list entity.
 */
async function sendOrUpdateList(ctx: Context, category?: Category, editMessageId?: number) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const isGroup = ctx.chat?.type !== 'private';
  const chatDisplayName = isGroup ? (ctx.chat?.title || 'Группа') : ctx.from?.first_name;

  const user = await getOrCreateUser(chatId, ctx.from?.username, chatDisplayName);
  const targetCategory = category || user.active_category;

  if (category && category !== user.active_category) {
    await setUserCategory(chatId, targetCategory);
  }

  // Obtain current active list entity
  const activeList = await getOrCreateActiveList(chatId);

  const [items, stats] = await Promise.all([
    getListItems(activeList.id, targetCategory),
    getListStats(activeList.id),
  ]);

  const messageText = renderListMessage(targetCategory, items, stats, isGroup);
  const keyboard = buildListKeyboard(targetCategory, items, stats);

  if (editMessageId) {
    try {
      await ctx.api.editMessageText(chatId, editMessageId, messageText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      await setListLastMessageId(activeList.id, editMessageId);
      return;
    } catch (e: any) {
      if (!String(e?.message).includes('message is not modified')) {
        console.error('Failed to edit message:', e);
      }
    }
  }

  // Delete all previous list cards (including closed lists and previous active card)
  const previousCardIds = await getAllListMessageIds(chatId, activeList.id);
  const oldActiveId = activeList.last_message_id;
  if (oldActiveId && !previousCardIds.includes(oldActiveId)) {
    previousCardIds.push(oldActiveId);
  }

  const cardsToDelete = previousCardIds.filter((id) => id !== editMessageId);
  if (cardsToDelete.length > 0) {
    await deleteMessagesSafe(ctx, chatId, cardsToDelete);
    await clearListMessageIds(chatId, cardsToDelete);
  }

  const sent = await ctx.reply(messageText, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
  await setListLastMessageId(activeList.id, sent.message_id);

  // Sweep any intermediate messages between previous card position and new card position
  if (oldActiveId && oldActiveId < sent.message_id - 1) {
    const sweepRange: number[] = [];
    for (let id = oldActiveId + 1; id < sent.message_id; id++) {
      sweepRange.push(id);
    }
    if (sweepRange.length > 0 && sweepRange.length <= 100) {
      await deleteMessagesSafe(ctx, chatId, sweepRange);
    }
  }
}

// ---------------- COMMAND HANDLERS ---------------- //

bot.command('start', async (ctx) => {
  try { await ctx.deleteMessage(); } catch {}
  const chatId = ctx.chat.id;
  await getOrCreateUser(chatId, ctx.from?.username, ctx.from?.first_name);

  const startParam = ctx.match?.trim();
  if (startParam && startParam.startsWith('scan_')) {
    const barcode = startParam.replace('scan_', '').trim();
    if (barcode) {
      const activeList = await getOrCreateActiveList(chatId);
      const scanned = await processScannedProduct(chatId, activeList.id, { barcode });
      await sendOrUpdateList(ctx, 'shopping');
      const priceInfo = scanned.price ? ` (${scanned.price} ₽)` : '';
      if (scanned.success) {
        const title = scanned.matchedItem ? 'Штрихкод считан' : 'Товар добавлен сканером';
        await ctx.reply(
          `✅ <b>${title}:</b> «${scanned.productName}»${priceInfo}\n` +
          `<i>Отмечен в списке покупок как купленный!</i>`,
          { parse_mode: 'HTML' }
        );
      }
      return;
    }
  }

  const aiStatus = config.isAiEnabled
    ? '✨ <b>AI-распознавание (Gemini):</b> включено'
    : '⚙️ <b>Парсер:</b> быстрый локальный (без внешних API)';

  const welcome = `👋 <b>Привет! Я бот для покупок и дел.</b>

Я создаю списки покупок и задач и веду их как единую сущность:
• Вы можете дополнять активный список любыми сообщениями
• Список будет дополняться до тех пор, пока вы не нажмете кнопку <b>Закрыть список</b>
• После закрытия следующее сообщение начнет новый список

${aiStatus}

<b>Как добавлять пункты:</b>
• Просто пишите сообщение: <code>молоко, хлеб, 10 сырков</code>
• Или построчно со знаками <code>-</code> или цифрами
• Или свободным текстом или голосом

Управляйте активным списком кнопками ниже 👇`;

  await ctx.reply(welcome, { parse_mode: 'HTML' });
  await sendOrUpdateList(ctx, 'shopping');
});

bot.command('help', async (ctx) => {
  try { await ctx.deleteMessage(); } catch {}
  const helpText = `📖 <b>Справка по командам:</b>

/list — показать текущий активный список
/shopping — открыть 🛒 Список покупок
/tasks — открыть 📝 Список дел и задач
/scan — 📷 проверить штрихкод товара или цену
/clean — 🧹 удалить старые сообщения и закрытые списки до текущего
/clear — удалить выполненные пункты из активного списка
/close — 🏁 закрыть текущий список (следующее сообщение начнет новый список)
/export — экспортировать списки обычным текстом
/stats — посмотреть статистику активного списка

<b>Штрихкоды и цены:</b>
• Просто сфотографируйте штрихкод или ценник и отправьте в чат!
• Или отправьте цифры штрихкода: <code>/scan 4600605021234</code>
• Изменить цену вручную: «✏️ Управление списком» ➔ выберите товар ➔ «💵 Указать цену»

<b>Редактирование:</b>
• Кнопка «✏️ Управление списком» внизу карточки
• Или напишите: <code>измени 2 на ...</code> или <code>/edit 2 ...</code>`;

  await ctx.reply(helpText, { parse_mode: 'HTML' });
});

bot.command(['list', 'menu'], async (ctx) => {
  try { await ctx.deleteMessage(); } catch {}
  await sendOrUpdateList(ctx);
});

bot.command(['shopping', 'buy'], async (ctx) => {
  try { await ctx.deleteMessage(); } catch {}
  await sendOrUpdateList(ctx, 'shopping');
});

bot.command(['tasks', 'todo'], async (ctx) => {
  try { await ctx.deleteMessage(); } catch {}
  await sendOrUpdateList(ctx, 'task');
});

bot.command('clear', async (ctx) => {
  try { await ctx.deleteMessage(); } catch {}
  const chatId = ctx.chat.id;
  const user = await getOrCreateUser(chatId);
  const activeList = await getOrCreateActiveList(chatId);
  await clearCompletedFromList(activeList.id, user.active_category);
  await sendOrUpdateList(ctx, user.active_category);
});

bot.command(['clean', 'purge', 'sweep'], async (ctx) => {
  const chatId = ctx.chat.id;
  const currentMsgId = ctx.message?.message_id;

  // Immediately delete the /clean command message itself
  try { await ctx.deleteMessage(); } catch {}

  const activeList = await getOrCreateActiveList(chatId);
  const targetCardId = activeList.last_message_id;

  // 1. Delete all old recorded list cards from closed lists
  const oldCardIds = await getAllListMessageIds(chatId, activeList.id);
  if (oldCardIds.length > 0) {
    await deleteMessagesSafe(ctx, chatId, oldCardIds);
    await clearListMessageIds(chatId, oldCardIds);
  }

  // 2. Generate a sweep range of messages before the current list card (up to 100 messages)
  const anchorId = targetCardId || currentMsgId;
  if (anchorId) {
    const sweepRange: number[] = [];
    const sweepLimit = 100;
    for (let id = anchorId - 1; id >= Math.max(1, anchorId - sweepLimit); id--) {
      if (id !== targetCardId) {
        sweepRange.push(id);
      }
    }
    if (sweepRange.length > 0) {
      await deleteMessagesSafe(ctx, chatId, sweepRange);
    }
  }

  // 3. Ensure the current active list is visible at the bottom
  if (!targetCardId) {
    await sendOrUpdateList(ctx);
  } else {
    // Show a temporary auto-deleting confirmation toast
    try {
      const notice = await ctx.reply('🧹 <i>История очищена до актуального списка.</i>', { parse_mode: 'HTML' });
      setTimeout(async () => {
        try { await ctx.api.deleteMessage(chatId, notice.message_id); } catch {}
      }, 3000);
    } catch {}
  }
});

bot.command('scan', async (ctx) => {
  const chatId = ctx.chat.id;
  const rawText = ctx.match?.trim() || '';

  try { await ctx.deleteMessage(); } catch {}

  if (!rawText) {
    const keyboard = new InlineKeyboard();
    if (config.webAppUrl) {
      keyboard.webApp('📷 Открыть камеру (сканер)', config.webAppUrl).row();
    }
    keyboard.text('❌ Закрыть', 'close_scan_prompt');
    await ctx.reply(
      '📷 <b>Сканирование товаров камерой:</b>\n\n' +
      (config.webAppUrl ? '• Нажмите кнопку ниже, чтобы <b>запустить живую камеру</b> прямо в Telegram.\n' : '') +
      '• <b>Сфотографировать камерой:</b> нажмите скрепку 📎 ➔ выберите значок <b>Камера 📷</b> прямо над клавиатурой (фотографируйте штрихкод без захода в галерею)!\n' +
      '• <b>Или отправьте номер штрихкода:</b> <code>/scan 4600605021234 [цена]</code>.\n\n' +
      '✨ <i>Бот автоматически определит товар, добавит его в список покупок и отметит как купленный с расчетом суммы в корзине!</i>',
      { parse_mode: 'HTML', reply_markup: keyboard }
    );
    return;
  }

  const parts = rawText.split(/\s+/);
  const barcode = parts[0].replace(/\D+/g, '');
  const price = parts[1] ? parseFloat(parts[1].replace(',', '.')) : null;

  const activeList = await getOrCreateActiveList(chatId);
  const scanned = await processScannedProduct(chatId, activeList.id, {
    barcode,
    price: price && !isNaN(price) && price > 0 ? price : null,
  });

  if (scanned.success && scanned.matchedItem) {
    const priceInfo = scanned.price ? ` (${scanned.price} ₽)` : '';
    await sendOrUpdateList(ctx, 'shopping');
    const notice = await ctx.reply(
      `✅ <b>Штрихкод найден:</b> «${scanned.productName}»${priceInfo}\n` +
      `<i>Пункт «${scanned.matchedItem.text}» отмечен как купленный!</i>`,
      { parse_mode: 'HTML' }
    );
    setTimeout(async () => {
      try { await ctx.api.deleteMessage(chatId, notice.message_id); } catch {}
    }, 4000);
  } else if (scanned.success && scanned.isNewItem) {
    const priceInfo = scanned.price ? ` (${scanned.price} ₽)` : '';
    await sendOrUpdateList(ctx, 'shopping');
    const notice = await ctx.reply(
      `✅ <b>Товар добавлен сканером:</b> «${scanned.productName}»${priceInfo}\n` +
      `<i>Добавлен в список покупок и отмечен как купленный!</i>`,
      { parse_mode: 'HTML' }
    );
    setTimeout(async () => {
      try { await ctx.api.deleteMessage(chatId, notice.message_id); } catch {}
    }, 4000);
  } else {
    const failNotice = await ctx.reply(
      `⚠️ Штрихкод <code>${barcode}</code> не найден в базах. Вы можете добавить товар вручную.`,
      { parse_mode: 'HTML' }
    );
    setTimeout(async () => {
      try { await ctx.api.deleteMessage(chatId, failNotice.message_id); } catch {}
    }, 4000);
  }
});

bot.command(['close', 'finish'], async (ctx) => {
  try { await ctx.deleteMessage(); } catch {}
  const chatId = ctx.chat.id;
  const activeList = await getOrCreateActiveList(chatId);
  const stats = await getListStats(activeList.id);

  // Delete previous active list card on close
  if (activeList.last_message_id) {
    try {
      await ctx.api.deleteMessage(chatId, activeList.last_message_id);
    } catch {}
  }

  const closedList = await closeActiveList(chatId);

  const total = stats.shoppingTotal + stats.taskTotal;
  const done = stats.shoppingDone + stats.taskDone;

  const sent = await ctx.reply(
    `🏁 <b>Список успешно закрыт!</b>\n\n` +
    `Всего было пунктов: <b>${total}</b> (выполнено: <b>${done}</b>)\n\n` +
    `💡 <i>Следующее сообщение с покупками или делами создаст новый список.</i>`,
    { parse_mode: 'HTML' }
  );

  if (closedList) {
    await setListLastMessageId(closedList.id, sent.message_id);
  }
});

bot.command('export', async (ctx) => {
  try { await ctx.deleteMessage(); } catch {}
  const chatId = ctx.chat.id;
  const activeList = await getOrCreateActiveList(chatId);
  const [shoppingItems, taskItems] = await Promise.all([
    getListItems(activeList.id, 'shopping'),
    getListItems(activeList.id, 'task'),
  ]);

  if (shoppingItems.length === 0 && taskItems.length === 0) {
    await ctx.reply('Активный список пуст.');
    return;
  }

  let text = '📋 <b>Текущий активный список:</b>\n\n';

  if (shoppingItems.length > 0) {
    text += '<b>🛒 Список покупок:</b>\n\n';
    for (const item of shoppingItems) {
      const mark = item.is_done ? '<s>[x]' : '[ ]';
      const endMark = item.is_done ? '</s>' : '';
      const qtyStr = item.quantity && item.quantity > 1 ? ` (${item.quantity} шт.)` : '';
      text += `${mark} ${item.text}${qtyStr}${endMark}\n\n`;
    }
  }

  if (taskItems.length > 0) {
    text += '<b>📝 Список дел:</b>\n\n';
    for (const item of taskItems) {
      const mark = item.is_done ? '<s>[x]' : '[ ]';
      const endMark = item.is_done ? '</s>' : '';
      const qtyStr = item.quantity && item.quantity > 1 ? ` (${item.quantity} шт.)` : '';
      text += `${mark} ${item.text}${qtyStr}${endMark}\n\n`;
    }
  }

  await ctx.reply(text, { parse_mode: 'HTML' });
});

bot.command('stats', async (ctx) => {
  try { await ctx.deleteMessage(); } catch {}
  const chatId = ctx.chat.id;
  const activeList = await getOrCreateActiveList(chatId);
  const stats = await getListStats(activeList.id);

  const statsText = `📊 <b>Статистика текущего активного списка:</b>

🛒 <b>Покупки:</b>
• Всего: ${stats.shoppingTotal}
• Куплено: ${stats.shoppingDone}
• Осталось: ${stats.shoppingTotal - stats.shoppingDone}

📝 <b>Дела и задачи:</b>
• Всего: ${stats.taskTotal}
• Выполнено: ${stats.taskDone}
• В процессе: ${stats.taskTotal - stats.taskDone}`;

  await ctx.reply(statsText, { parse_mode: 'HTML' });
});

// ---------------- MESSAGE TEXT PROCESSING ---------------- //

bot.on('message:text', async (ctx) => {
  let rawText = ctx.message.text.trim();
  if (rawText.startsWith('/')) return; // Ignore slash commands

  const chatId = ctx.chat.id;
  const isGroup = ctx.chat.type !== 'private';
  const botUsername = ctx.me.username;

  // Strip @botname mention if present
  const isMentioned = Boolean(botUsername && rawText.includes(`@${botUsername}`));
  if (isMentioned && botUsername) {
    rawText = rawText.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim();
  }

  // Check if message is a reply to the bot
  const isReplyToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;

  // In groups, ignore conversational chatter ("hello", "ok", "bye") unless directed at bot
  if (isGroup && !isMentioned && !isReplyToBot) {
    if (isConversationalNoise(rawText)) {
      return;
    }
  }

  if (!rawText) return;

  const chatDisplayName = isGroup ? (ctx.chat.title || 'Группа') : ctx.from?.first_name;
  const user = await getOrCreateUser(chatId, ctx.from?.username, chatDisplayName);

  // 1. Check if user is in an active item edit prompt (text or price)
  if (pendingEdits.has(chatId)) {
    const edit = pendingEdits.get(chatId)!;
    pendingEdits.delete(chatId);

    if (edit.promptMsgId) {
      try { await ctx.api.deleteMessage(chatId, edit.promptMsgId); } catch {}
    }
    try { await ctx.deleteMessage(); } catch {}

    if (edit.type === 'price') {
      const priceVal = parseFloat(rawText.replace(',', '.').replace(/[^\d.]/g, ''));
      if (!isNaN(priceVal) && priceVal >= 0) {
        await setItemPriceAndBarcode(chatId, edit.itemId, Math.round(priceVal * 100) / 100);
      }
      await sendOrUpdateList(ctx, user.active_category);
      return;
    }

    const parsedQty = extractQuantity(rawText);
    await updateItemText(chatId, edit.itemId, parsedQty.text);
    if (parsedQty.quantity > 1) {
      const existing = await getItemById(chatId, edit.itemId);
      const currentQty = existing?.quantity || 1;
      await updateItemQuantity(chatId, edit.itemId, parsedQty.quantity - currentQty);
    }

    await sendOrUpdateList(ctx, user.active_category);
    return;
  }

  // 1.5. Direct barcode text message (8-14 digits)
  if (/^\d{8,14}$/.test(rawText)) {
    try { await ctx.deleteMessage(); } catch {}
    const activeList = await getOrCreateActiveList(chatId);
    const scanned = await processScannedProduct(chatId, activeList.id, { barcode: rawText });

    if (scanned.success && scanned.matchedItem) {
      await sendOrUpdateList(ctx, 'shopping');
      const priceInfo = scanned.price ? ` (${scanned.price} ₽)` : '';
      const notice = await ctx.reply(
        `✅ <b>Штрихкод считан:</b> «${scanned.productName}»${priceInfo}\n<i>Пункт «${scanned.matchedItem.text}» отмечен как купленный!</i>`,
        { parse_mode: 'HTML' }
      );
      setTimeout(async () => {
        try { await ctx.api.deleteMessage(chatId, notice.message_id); } catch {}
      }, 4000);
      return;
    } else if (scanned.success && scanned.isNewItem) {
      await sendOrUpdateList(ctx, 'shopping');
      const priceInfo = scanned.price ? ` (${scanned.price} ₽)` : '';
      const notice = await ctx.reply(
        `✅ <b>Товар добавлен сканером:</b> «${scanned.productName}»${priceInfo}\n<i>Добавлен в список покупок и отмечен как купленный!</i>`,
        { parse_mode: 'HTML' }
      );
      setTimeout(async () => {
        try { await ctx.api.deleteMessage(chatId, notice.message_id); } catch {}
      }, 4000);
      return;
    }
  }

  // 2. Check for natural conversational edit commands: "измени 2 на ...", "замени 1 на ...", "/edit 2 ..."
  const editMatch = rawText.match(/^(?:измени(?:ть)?|поменяй|замени(?:ть)?|исправь|правка|\/edit)\s+(\d+)\s*(?:на|в|:|-)?\s+(.+)$/iu);
  if (editMatch) {
    const itemNumber = parseInt(editMatch[1], 10);
    const newRaw = editMatch[2].trim();

    try { await ctx.deleteMessage(); } catch {}

    const activeList = await getOrCreateActiveList(chatId);
    const items = await getListItems(activeList.id, user.active_category);

    if (itemNumber >= 1 && itemNumber <= items.length) {
      const targetItem = items[itemNumber - 1];
      const parsed = extractQuantity(newRaw);
      await updateItemText(chatId, targetItem.id, parsed.text);
      if (parsed.quantity !== targetItem.quantity) {
        await updateItemQuantity(chatId, targetItem.id, parsed.quantity - targetItem.quantity);
      }
      await sendOrUpdateList(ctx, user.active_category);
      return;
    }
  }

  // Send immediate feedback message so user knows text is received and being processed
  const statusMsg = await ctx.reply('⏳ <i>Запрос принят, обрабатываю...</i>', {
    parse_mode: 'HTML',
  });

  await ctx.replyWithChatAction('typing');

  // Keep chat action "typing" active while AI request or retries are processing
  const typingTimer = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);

  let parsedItems;
  try {
    parsedItems = await parseMessage(rawText, user.active_category, async (progressText) => {
      try {
        await ctx.api.editMessageText(chatId, statusMsg.message_id, progressText, { parse_mode: 'HTML' });
      } catch {}
    });
  } finally {
    clearInterval(typingTimer);
  }

  // Delete status feedback message upon completion
  try {
    await ctx.api.deleteMessage(chatId, statusMsg.message_id);
  } catch {}

  if (!parsedItems || parsedItems.length === 0) {
    if (!isGroup) {
      await ctx.reply('Не удалось распознать пункты. Отправьте список через запятую или построчно.');
    }
    return;
  }

  // Delete incoming user text message to keep chat history clean
  try {
    await ctx.deleteMessage();
  } catch {
    // Ignore permissions failure in groups
  }

  // Always append items to the currently active list entity
  const activeList = await getOrCreateActiveList(chatId);

  await addItems(
    activeList.id,
    chatId,
    parsedItems.map((p) => ({
      category: p.category,
      text: p.text,
      quantity: p.quantity,
    }))
  );

  const shoppingAdded = parsedItems.filter((i) => i.category === 'shopping');
  const tasksAdded = parsedItems.filter((i) => i.category === 'task');
  const primaryCategory = tasksAdded.length > shoppingAdded.length ? 'task' : 'shopping';

  // Automatically delete old list card and send the fresh updated list at the bottom
  await sendOrUpdateList(ctx, primaryCategory);
});

// ---------------- VOICE AND AUDIO MESSAGE PROCESSING ---------------- //

bot.on(['message:voice', 'message:audio'], async (ctx) => {
  const voice = ctx.message.voice || ctx.message.audio;
  if (!voice) return;

  const chatId = ctx.chat.id;
  const isGroup = ctx.chat.type !== 'private';

  // 1. Immediately confirm receipt so the user gets instant visual feedback
  const statusMsg = await ctx.reply('🎙 <b>Голосовое сообщение получено!</b>\n⏳ <i>Подготовка к обработке...</i>', {
    parse_mode: 'HTML',
  });

  if (!config.isAiEnabled) {
    await ctx.api.editMessageText(
      chatId,
      statusMsg.message_id,
      '❌ <b>Gemini AI не подключен!</b>\n\n' +
      'Для распознавания голоса требуется добавить <code>GEMINI_API_KEY</code> в файл <code>.env</code> на сервере и перезапустить бота.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  await ctx.replyWithChatAction('record_voice');

  try {
    const file = await ctx.api.getFile(voice.file_id);
    if (!file.file_path) {
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        '❌ Не удалось получить путь к аудиофайлу от Telegram API.'
      );
      return;
    }

    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const res = await fetch(fileUrl);
    if (!res.ok) {
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        `❌ Ошибка скачивания аудиофайла: ${res.status} ${res.statusText}`
      );
      return;
    }

    const arrayBuffer = await res.arrayBuffer();
    const base64Audio = Buffer.from(arrayBuffer).toString('base64');
    const rawMime = ('mime_type' in voice && voice.mime_type) ? voice.mime_type : 'audio/ogg';

    const onProgress = async (text: string) => {
      try {
        await ctx.api.editMessageText(chatId, statusMsg.message_id, text, { parse_mode: 'HTML' });
      } catch {
        // Ignore edit rate limits or unchanged message errors from Telegram
      }
    };

    const chatDisplayName = isGroup ? (ctx.chat.title || 'Группа') : ctx.from?.first_name;
    const user = await getOrCreateUser(chatId, ctx.from?.username, chatDisplayName);

    const voiceResult = await parseVoiceWithGemini(
      base64Audio,
      rawMime,
      user.active_category,
      onProgress
    );

    if (!voiceResult.success) {
      const errText = voiceResult.error || 'Неизвестная ошибка';
      const isHighDemand =
        errText.includes('503') ||
        errText.includes('high demand') ||
        errText.includes('UNAVAILABLE') ||
        errText.includes('Timeout');

      const hint = isHighDemand
        ? '⏳ Серверы Google Gemini сейчас временно перегружены. Бот опробовал доступные модели, но не получил своевременного ответа. Пожалуйста, повторите попытку через минуту или отправьте текст.'
        : 'Проверьте правильность токена GEMINI_API_KEY и лимиты в Google AI Studio.';

      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        `❌ <b>Ошибка Gemini AI:</b>\n<code>${errText}</code>\n\n${hint}`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const transcript = voiceResult.transcript || '';

    if (voiceResult.items.length === 0) {
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        `🎙 <b>Расшифровано:</b> «<i>${transcript || '(пусто)'}</i>»\n\n` +
        `⚠️ В сообщении не удалось найти конкретных покупок или дел. Попробуйте сказать, например: <i>«Купить молоко, сыр и хлеб»</i>.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // Always append items to the currently active list entity
    const activeList = await getOrCreateActiveList(chatId);

    await addItems(
      activeList.id,
      chatId,
      voiceResult.items.map((p) => ({
        category: p.category,
        text: p.text,
        quantity: p.quantity,
      }))
    );

    const shoppingAdded = voiceResult.items.filter((i) => i.category === 'shopping');
    const tasksAdded = voiceResult.items.filter((i) => i.category === 'task');
    const primaryCategory = tasksAdded.length > shoppingAdded.length ? 'task' : 'shopping';

    // Delete the temporary status message now that items are added
    let isStatusDeleted = false;
    try {
      await ctx.api.deleteMessage(chatId, statusMsg.message_id);
      isStatusDeleted = true;
    } catch {
      try {
        await ctx.api.editMessageText(chatId, statusMsg.message_id, '✅ <i>Обработано</i>', { parse_mode: 'HTML' });
      } catch {}
    }

    // Delete incoming voice message to keep chat history clean
    try {
      await ctx.deleteMessage();
    } catch {}

    // Automatically delete old list card and send the fresh updated list at the bottom
    await sendOrUpdateList(ctx, primaryCategory);
  } catch (error: any) {
    console.error('Error handling voice message:', error);
    try {
      const errorMsg = `❌ <b>Ошибка при обработке голоса:</b>\n<code>${error?.message || error}</code>`;
      await ctx.reply(errorMsg, { parse_mode: 'HTML' });
    } catch {}
  }
});

// ---------------- MESSAGE PHOTO / BARCODE SCAN PROCESSING ---------------- //

bot.on('message:photo', async (ctx) => {
  const chatId = ctx.chat.id;

  // Show immediate progress status message
  const statusMsg = await ctx.reply('📷 <i>Анализирую фото: поиск штрихкода, товара и ценника...</i>', {
    parse_mode: 'HTML',
  });

  try {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.api.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;

    const res = await fetch(fileUrl);
    if (!res.ok) {
      throw new Error(`Failed to download photo: ${res.statusText}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());

    // Recognize with Gemini Vision
    const scanned = await recognizeBarcodeAndProductFromImage(buffer, 'image/jpeg');

    const activeList = await getOrCreateActiveList(chatId);
    const result = await processScannedProduct(chatId, activeList.id, scanned);

    // Delete temporary status message and user incoming photo to keep chat clean
    try { await ctx.api.deleteMessage(chatId, statusMsg.message_id); } catch {}
    try { await ctx.deleteMessage(); } catch {}

    if (result.success && result.matchedItem) {
      const priceInfo = result.price ? ` (${result.price} ₽)` : '';
      await sendOrUpdateList(ctx, 'shopping');

      const notice = await ctx.reply(
        `✅ <b>Штрихкод считан:</b> «${result.productName}»${priceInfo}\n` +
        `<i>Пункт «${result.matchedItem.text}» отмечен как купленный!</i>`,
        { parse_mode: 'HTML' }
      );
      setTimeout(async () => {
        try { await ctx.api.deleteMessage(chatId, notice.message_id); } catch {}
      }, 4000);
    } else if (result.success && result.isNewItem) {
      const priceInfo = result.price ? ` (${result.price} ₽)` : '';
      await sendOrUpdateList(ctx, 'shopping');

      const notice = await ctx.reply(
        `✅ <b>Товар добавлен сканером:</b> «${result.productName}»${priceInfo}\n` +
        `<i>Добавлен в список покупок и отмечен как купленный!</i>`,
        { parse_mode: 'HTML' }
      );
      setTimeout(async () => {
        try { await ctx.api.deleteMessage(chatId, notice.message_id); } catch {}
      }, 4000);
    } else {
      const failNotice = await ctx.reply(
        '⚠️ <b>Не удалось распознать штрихкод или товар на фото.</b>\n<i>Попробуйте сфотографировать штрихкод крупнее при хорошем освещении или введите цифры: <code>/scan 460...</code></i>',
        { parse_mode: 'HTML' }
      );
      setTimeout(async () => {
        try { await ctx.api.deleteMessage(chatId, failNotice.message_id); } catch {}
      }, 5000);
    }
  } catch (err: any) {
    console.error('Error handling photo message:', err);
    try { await ctx.api.deleteMessage(chatId, statusMsg.message_id); } catch {}
    try { await ctx.deleteMessage(); } catch {}
    const errNotice = await ctx.reply(
      `❌ <b>Ошибка распознавания:</b> <code>${err?.message || err}</code>`,
      { parse_mode: 'HTML' }
    );
    setTimeout(async () => {
      try { await ctx.api.deleteMessage(chatId, errNotice.message_id); } catch {}
    }, 4000);
  }
});

bot.on('message:web_app_data', async (ctx) => {
  const chatId = ctx.chat.id;
  const rawData = ctx.message.web_app_data.data.trim();
  try { await ctx.deleteMessage(); } catch {}

  if (!rawData) return;

  const activeList = await getOrCreateActiveList(chatId);
  const scanned = await processScannedProduct(chatId, activeList.id, { barcode: rawData });

  if (scanned.success && scanned.matchedItem) {
    const priceInfo = scanned.price ? ` (${scanned.price} ₽)` : '';
    await sendOrUpdateList(ctx, 'shopping');
    const notice = await ctx.reply(
      `✅ <b>Штрихкод считан:</b> «${scanned.productName}»${priceInfo}\n` +
      `<i>Пункт «${scanned.matchedItem.text}» отмечен как купленный!</i>`,
      { parse_mode: 'HTML' }
    );
    setTimeout(async () => {
      try { await ctx.api.deleteMessage(chatId, notice.message_id); } catch {}
    }, 4000);
  } else if (scanned.success && scanned.isNewItem) {
    const priceInfo = scanned.price ? ` (${scanned.price} ₽)` : '';
    await sendOrUpdateList(ctx, 'shopping');
    const notice = await ctx.reply(
      `✅ <b>Товар добавлен сканером:</b> «${scanned.productName}»${priceInfo}\n` +
      `<i>Добавлен в список покупок и отмечен как купленный!</i>`,
      { parse_mode: 'HTML' }
    );
    setTimeout(async () => {
      try { await ctx.api.deleteMessage(chatId, notice.message_id); } catch {}
    }, 4000);
  } else {
    const failNotice = await ctx.reply(
      `⚠️ Штрихкод <code>${rawData}</code> не найден в базах.`,
      { parse_mode: 'HTML' }
    );
    setTimeout(async () => {
      try { await ctx.api.deleteMessage(chatId, failNotice.message_id); } catch {}
    }, 4000);
  }
});

// ---------------- CALLBACK QUERY HANDLERS ---------------- //

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat?.id;
  const messageId = ctx.callbackQuery.message?.message_id;

  if (!chatId || !messageId) {
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === 'noop') {
    await ctx.answerCallbackQuery();
    return;
  }

  // Barcode / product scanner prompt: scan_prompt
  if (data === 'scan_prompt') {
    await ctx.answerCallbackQuery();
    const promptKeyboard = new InlineKeyboard();
    if (config.webAppUrl) {
      promptKeyboard.webApp('📷 Открыть камеру (сканер)', config.webAppUrl).row();
    }
    promptKeyboard.text('❌ Закрыть', 'close_scan_prompt');

    await ctx.reply(
      '📷 <b>Сканирование товаров камерой</b>\n\n' +
      (config.webAppUrl ? '• Нажмите кнопку ниже, чтобы <b>запустить живую камеру</b> прямо в Telegram.\n' : '') +
      '• <b>Сфотографировать камерой:</b> нажмите скрепку 📎 ➔ выберите значок <b>Камера 📷</b> прямо над клавиатурой (фотографируйте штрихкод сразу, без перехода в галерею)!\n' +
      '• <b>Или отправьте номер штрихкода:</b> <code>/scan 4600605021234 [цена]</code>.\n\n' +
      '✨ <i>Бот автоматически определит товар, добавит его в список покупок и отметит как купленный с расчетом суммы в корзине!</i>',
      {
        parse_mode: 'HTML',
        reply_markup: promptKeyboard,
      }
    );
    return;
  }

  // Close scanner prompt: close_scan_prompt
  if (data === 'close_scan_prompt') {
    try { await ctx.deleteMessage(); } catch {}
    await ctx.answerCallbackQuery();
    return;
  }

  // Manage entire list items view: manage_list:<category>
  if (data.startsWith('manage_list:')) {
    const category = data.split(':')[1] as Category;
    const activeList = await getOrCreateActiveList(chatId);
    const items = await getListItems(activeList.id, category);

    if (items.length === 0) {
      await ctx.answerCallbackQuery({ text: 'В этом списке пока нет пунктов' });
      return;
    }

    await ctx.answerCallbackQuery();
    const catTitle = category === 'shopping' ? '🛒 Покупки' : '📝 Дела';
    const text = `⚙️ <b>Управление списком (${catTitle}):</b>\n\n` +
      `Нажмите на позицию, чтобы изменить текст, количество или удалить:`;
    const keyboard = buildManageListKeyboard(category, items);

    try {
      await ctx.api.editMessageText(chatId, messageId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (e: any) {
      if (!String(e?.message).includes('message is not modified')) {
        console.error('Failed to edit message in manage_list:', e);
      }
    }
    return;
  }

  // Manage individual item view: manage_item:<id>
  if (data.startsWith('manage_item:')) {
    const itemId = Number(data.split(':')[1]);
    const item = await getItemById(chatId, itemId);
    if (!item) {
      await ctx.answerCallbackQuery({ text: 'Пункт не найден' });
      return;
    }

    await ctx.answerCallbackQuery();
    const statusStr = item.is_done ? '✅ Выполнено' : '⬜ В процессе';
    const qtyStr = item.quantity && item.quantity > 1 ? ` (${item.quantity} шт.)` : '';
    const text = `⚙️ <b>Позиция:</b> «<b>${item.text}</b>»${qtyStr}\n` +
      `Статус: <b>${statusStr}</b>\n\n` +
      `Выберите действие:`;
    const keyboard = buildManageItemKeyboard(item);

    try {
      await ctx.api.editMessageText(chatId, messageId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (e: any) {
      if (!String(e?.message).includes('message is not modified')) {
        console.error('Failed to edit message in manage_item:', e);
      }
    }
    return;
  }

  // Increment item quantity: qty_inc:<id>
  if (data.startsWith('qty_inc:')) {
    const itemId = Number(data.split(':')[1]);
    const newQty = await updateItemQuantity(chatId, itemId, +1);
    await ctx.answerCallbackQuery({ text: `Количество: ${newQty} шт.` });

    const isManageCard = Boolean(ctx.callbackQuery.message?.text?.includes('Позиция:'));
    if (isManageCard) {
      const updated = await getItemById(chatId, itemId);
      if (updated) {
        const statusStr = updated.is_done ? '✅ Выполнено' : '⬜ В процессе';
        const qtyStr = updated.quantity && updated.quantity > 1 ? ` (${updated.quantity} шт.)` : '';
        const text = `⚙️ <b>Позиция:</b> «<b>${updated.text}</b>»${qtyStr}\n` +
          `Статус: <b>${statusStr}</b>\n\n` +
          `Выберите действие:`;
        try {
          await ctx.api.editMessageText(chatId, messageId, text, {
            parse_mode: 'HTML',
            reply_markup: buildManageItemKeyboard(updated),
          });
          return;
        } catch {}
      }
    }

    const user = await getOrCreateUser(chatId);
    await sendOrUpdateList(ctx, user.active_category, messageId);
    return;
  }

  // Decrement item quantity: qty_dec:<id>
  if (data.startsWith('qty_dec:')) {
    const itemId = Number(data.split(':')[1]);
    const item = await getItemById(chatId, itemId);
    if (item && item.quantity <= 1) {
      await ctx.answerCallbackQuery({ text: 'Количество: 1 шт. (минимум)' });
      return;
    }
    const newQty = await updateItemQuantity(chatId, itemId, -1);
    await ctx.answerCallbackQuery({ text: `Количество: ${newQty} шт.` });

    const isManageCard = Boolean(ctx.callbackQuery.message?.text?.includes('Позиция:'));
    if (isManageCard) {
      const updated = await getItemById(chatId, itemId);
      if (updated) {
        const statusStr = updated.is_done ? '✅ Выполнено' : '⬜ В процессе';
        const qtyStr = updated.quantity && updated.quantity > 1 ? ` (${updated.quantity} шт.)` : '';
        const text = `⚙️ <b>Позиция:</b> «<b>${updated.text}</b>»${qtyStr}\n` +
          `Статус: <b>${statusStr}</b>\n\n` +
          `Выберите действие:`;
        try {
          await ctx.api.editMessageText(chatId, messageId, text, {
            parse_mode: 'HTML',
            reply_markup: buildManageItemKeyboard(updated),
          });
          return;
        } catch {}
      }
    }

    const user = await getOrCreateUser(chatId);
    await sendOrUpdateList(ctx, user.active_category, messageId);
    return;
  }

  // Delete item: del_item:<id>
  if (data.startsWith('del_item:')) {
    const itemId = Number(data.split(':')[1]);
    const item = await getItemById(chatId, itemId);
    const itemName = item ? item.text : 'Пункт';

    await deleteItem(chatId, itemId);
    await ctx.answerCallbackQuery({ text: `Удалено: ${itemName}` });

    const user = await getOrCreateUser(chatId);
    await sendOrUpdateList(ctx, user.active_category, messageId);
    return;
  }

  // Prompt edit help: prompt_edit:<category>
  if (data.startsWith('prompt_edit:')) {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      '✏️ <b>Как редактировать пункт списка:</b>\n\n' +
      'Отправьте сообщение с номером пункта и новым текстом:\n' +
      '• <code>измени 2 на Сырки 5 шт</code>\n' +
      '• <code>поменяй 1 на Свежее молоко</code>\n' +
      '• <code>/edit 3 Хлеб</code>',
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Interactive set item price: set_price:<id>
  if (data.startsWith('set_price:')) {
    const itemId = Number(data.split(':')[1]);
    const item = await getItemById(chatId, itemId);
    if (!item) {
      await ctx.answerCallbackQuery({ text: 'Пункт не найден' });
      return;
    }
    await ctx.answerCallbackQuery();

    const prev = pendingEdits.get(chatId);
    if (prev?.promptMsgId) {
      try { await ctx.api.deleteMessage(chatId, prev.promptMsgId); } catch {}
    }

    const cur = item.price ? ` (текущая: ${item.price} ₽)` : '';
    const prompt = await ctx.reply(
      `💵 <b>Укажите цену для:</b> «<i>${item.text}</i>»${cur}\n\n` +
      `Отправьте сумму в рублях числом (например: <code>89</code> или <code>149.50</code>):`,
      {
        parse_mode: 'HTML',
        reply_markup: buildCancelEditKeyboard(),
      }
    );

    pendingEdits.set(chatId, {
      type: 'price',
      itemId,
      itemText: item.text,
      promptMsgId: prompt.message_id,
    });
    return;
  }

  // Add scanned product as new bought item: add_scanned:<barcode>
  if (data.startsWith('add_scanned:')) {
    const barcode = data.split(':')[1];
    let name = 'Товар';
    let price: number | null = null;

    if (barcode) {
      const prod = await getProductByBarcode(barcode);
      if (prod) {
        name = prod.name;
        price = prod.price || null;
      }
    }

    const activeList = await getOrCreateActiveList(chatId);
    const addedIds = await addItems(activeList.id, chatId, [
      {
        category: 'shopping',
        text: name,
        price,
        barcode: barcode || undefined,
      },
    ]);

    if (addedIds.length > 0) {
      await toggleItemDone(chatId, addedIds[0]);
    }

    try { await ctx.deleteMessage(); } catch {}
    await ctx.answerCallbackQuery({ text: `Добавлено в корзину: ${name}` });
    await sendOrUpdateList(ctx, 'shopping');
    return;
  }

  // Cancel scanned product prompt
  if (data === 'cancel_scanned') {
    try { await ctx.deleteMessage(); } catch {}
    await ctx.answerCallbackQuery({ text: 'Отменено' });
    return;
  }

  // Interactive edit item text: edit_item:<id>
  if (data.startsWith('edit_item:')) {
    const itemId = Number(data.split(':')[1]);
    const item = await getItemById(chatId, itemId);
    if (!item) {
      await ctx.answerCallbackQuery({ text: 'Пункт не найден' });
      return;
    }
    await ctx.answerCallbackQuery();

    const prev = pendingEdits.get(chatId);
    if (prev?.promptMsgId) {
      try { await ctx.api.deleteMessage(chatId, prev.promptMsgId); } catch {}
    }

    const prompt = await ctx.reply(
      `✏️ <b>Редактирование:</b> «<i>${item.text}</i>»\n\n` +
      `Отправьте новый текст сообщением (можно указать количество, например: <code>Сырки 5 шт</code>):`,
      {
        parse_mode: 'HTML',
        reply_markup: buildCancelEditKeyboard(),
      }
    );

    pendingEdits.set(chatId, {
      itemId,
      itemText: item.text,
      promptMsgId: prompt.message_id,
    });
    return;
  }

  // Cancel edit mode
  if (data === 'cancel_edit') {
    const prev = pendingEdits.get(chatId);
    pendingEdits.delete(chatId);
    if (prev?.promptMsgId) {
      try { await ctx.api.deleteMessage(chatId, prev.promptMsgId); } catch {}
    }
    await ctx.answerCallbackQuery({ text: 'Правка отменена' });
    return;
  }

  // Switch category tabs: tab:shopping / tab:task
  if (data.startsWith('tab:')) {
    const category = data.split(':')[1] as Category;
    await setUserCategory(chatId, category);
    await ctx.answerCallbackQuery();
    await sendOrUpdateList(ctx, category, messageId);
    return;
  }

  // Toggle item done status: toggle:<id>
  if (data.startsWith('toggle:')) {
    const itemId = Number(data.split(':')[1]);
    const newStatus = await toggleItemDone(chatId, itemId);
    const user = await getOrCreateUser(chatId);

    const statusText = newStatus ? 'Выполнено! ✅' : 'Возвращено в список ⬜';
    await ctx.answerCallbackQuery({ text: statusText });
    await sendOrUpdateList(ctx, user.active_category, messageId);
    return;
  }

  // Delete completed items: clear_done:<category>
  if (data.startsWith('clear_done:')) {
    const category = data.split(':')[1] as Category;
    const activeList = await getOrCreateActiveList(chatId);
    const deleted = await clearCompletedFromList(activeList.id, category);
    await ctx.answerCallbackQuery({
      text: deleted > 0 ? `Удалено выполненных: ${deleted}` : 'Нет выполненных пунктов',
    });
    await sendOrUpdateList(ctx, category, messageId);
    return;
  }

  // Close active list prompt: confirm_finish:<category>
  if (data.startsWith('confirm_finish:')) {
    const category = data.split(':')[1] as Category;
    const catName = category === 'shopping' ? 'покупок' : 'дел';
    await ctx.answerCallbackQuery();
    await ctx.api.editMessageText(
      chatId,
      messageId,
      `🏁 <b>Вы уверены, что хотите закрыть текущий список ${catName}?</b>\n\nСписок будет зафиксирован и закрыт, а следующее сообщение создаст новый список.`,
      {
        parse_mode: 'HTML',
        reply_markup: buildConfirmFinishKeyboard(category),
      }
    );
    return;
  }

  // Execute close active list: do_finish:<category>
  if (data.startsWith('do_finish:')) {
    const category = data.split(':')[1] as Category;
    const activeList = await getOrCreateActiveList(chatId);
    const stats = await getListStats(activeList.id);
    const total = category === 'shopping' ? stats.shoppingTotal : stats.taskTotal;
    const done = category === 'shopping' ? stats.shoppingDone : stats.taskDone;

    // Close the list entity completely
    const closedList = await closeActiveList(chatId);

    await ctx.answerCallbackQuery({ text: 'Список закрыт! 🏁' });

    // Store messageId on the closed list entity so it is cleaned up when next list starts
    if (closedList) {
      await setListLastMessageId(closedList.id, messageId);
    }

    const title = category === 'shopping' ? '🛒 Список покупок' : '📝 Список дел';
    const closedText = `🏁 <b>${title} успешно закрыт!</b>\n\n` +
      `Всего было пунктов: <b>${total}</b> (выполнено: <b>${done}</b>)\n\n` +
      `💡 <i>Отправьте новое сообщение с текстом, чтобы начать новый список!</i>`;

    const closedKeyboard = new InlineKeyboard()
      .text('➕ Начать новый список', `tab:${category}`);

    await ctx.api.editMessageText(chatId, messageId, closedText, {
      parse_mode: 'HTML',
      reply_markup: closedKeyboard,
    });
    return;
  }

  // Clear category items prompt: confirm_clear:<category>
  if (data.startsWith('confirm_clear:')) {
    const category = data.split(':')[1] as Category;
    const catName = category === 'shopping' ? 'покупок' : 'дел';
    await ctx.answerCallbackQuery();
    await ctx.api.editMessageText(
      chatId,
      messageId,
      `⚠️ <b>Вы уверены, что хотите полностью очистить весь активный список ${catName}?</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: buildConfirmClearKeyboard(category),
      }
    );
    return;
  }

  // Execute clear category items: do_clear:<category>
  if (data.startsWith('do_clear:')) {
    const category = data.split(':')[1] as Category;
    const activeList = await getOrCreateActiveList(chatId);
    const deleted = await clearCategoryFromList(activeList.id, category);
    await ctx.answerCallbackQuery({ text: `Список очищен (удалено: ${deleted})` });
    await sendOrUpdateList(ctx, category, messageId);
    return;
  }

  // Export as text: export:<category>
  if (data.startsWith('export:')) {
    const category = data.split(':')[1] as Category;
    const activeList = await getOrCreateActiveList(chatId);
    const items = await getListItems(activeList.id, category);
    await ctx.answerCallbackQuery();

    if (items.length === 0) {
      await ctx.reply('Список пуст.');
      return;
    }

    const title = category === 'shopping' ? '🛒 Список покупок' : '📝 Список дел';
    let text = `<b>${title}:</b>\n\n`;
    for (const item of items) {
      const check = item.is_done ? '<s>🟢' : '▫️';
      const end = item.is_done ? '</s>' : '';
      const qtyStr = item.quantity && item.quantity > 1 ? ` (${item.quantity} шт.)` : '';
      text += `${check} ${item.text}${qtyStr}${end}\n\n`;
    }

    await ctx.reply(text, { parse_mode: 'HTML' });
    return;
  }

  // Refresh view: refresh:<category>
  if (data.startsWith('refresh:')) {
    const category = data.split(':')[1] as Category;
    await ctx.answerCallbackQuery({ text: 'Обновлено 🔄' });
    await sendOrUpdateList(ctx, category, messageId);
    return;
  }

  await ctx.answerCallbackQuery();
});

// ---------------- ERROR HANDLING AND STARTUP ---------------- //

bot.catch((err) => {
  console.error(`Error processing update ${err.ctx.update.update_id}:`, err.error);
});

async function main() {
  console.log('Initializing SQLite database...');
  await initDatabase();

  console.log('Starting Telegram bot...');
  if (config.isAiEnabled) {
    console.log('Gemini AI integration: ENABLED');
  } else {
    console.log('Gemini AI: not configured (using local parser)');
  }

  try {
    await bot.api.setMyCommands([
      { command: 'list', description: 'Показать текущий список' },
      { command: 'scan', description: '📷 Сканировать штрихкод / товар' },
      { command: 'shopping', description: '🛒 Список покупок' },
      { command: 'tasks', description: '📝 Список дел' },
      { command: 'clear', description: '🧹 Удалить выполненные' },
      { command: 'close', description: '🏁 Закрыть список' },
      { command: 'export', description: '📋 Экспорт текстом' },
      { command: 'stats', description: '📊 Статистика' },
      { command: 'help', description: '📖 Справка и помощь' },
      { command: 'myid', description: 'Показать мой Telegram ID' },
      { command: 'audit', description: 'Отчёт по пользователям и группам (владелец)' },
    ]);
  } catch (e) {
    console.warn('Could not register bot commands menu with Telegram API.');
  }

  bot.start({
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    onStart: (botInfo) => {
      console.log(`Bot @${botInfo.username} is running and ready!`);
    },
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
});
