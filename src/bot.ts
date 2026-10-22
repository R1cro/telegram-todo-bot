import { Bot, Context, InlineKeyboard } from 'grammy';
import { config, validateConfig } from './config.js';
import {
  initDatabase,
  getOrCreateUser,
  setUserCategory,
  getOrCreateActiveList,
  closeActiveList,
  setListLastMessageId,
  setListMessageIds,
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
  recordBotUserActivity,
  recordBotGroupMembership,
  getBotAuditData,
  addReceipt,
  getReceiptById,
  deleteReceipt,
  getRecentReceipts,
  markMatchingShoppingItemsDone,
  type Category,
  type TodoItem,
  type PeriodFilter,
} from './db.js';
import { parseMessage, parseVoiceWithGemini, extractQuantity } from './parser.js';
import { scanReceiptWithGemini } from './receipt-scanner.js';
import {
  renderExpensesDashboard,
  formatMoney,
  renderReceiptCard,
  renderReceiptsList,
  escapeHtml,
  type ExpensesTab,
} from './analytics.js';
import {
  buildListKeyboard,
  buildNavigationKeyboard,
  buildManageListKeyboard,
  buildManageItemKeyboard,
  buildConfirmClearKeyboard,
  buildConfirmFinishKeyboard,
  buildCancelEditKeyboard,
  buildExpensesKeyboard,
  buildReceiptCardKeyboard,
  buildReceiptsListKeyboard,
  buildReceiptDetailKeyboard,
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

  // Automatically leave if explicit group whitelist is configured and this group is not in it
  if (config.allowedChatIds.length > 0 && !config.allowedChatIds.includes(chat.id) && update.new_chat_member.status !== 'left') {
    try {
      await ctx.leaveChat();
    } catch {}
  }
});

// Enforce user access restrictions
bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return next();

  // Allow /myid for anyone to discover their Telegram ID
  const text = ctx.message?.text?.trim() || '';
  if (text.startsWith('/myid')) {
    return next();
  }

  // Allow /audit for administrators in private chat
  if (text.startsWith('/audit') && ctx.from && config.adminUserIds.includes(ctx.from.id)) {
    return next();
  }

  // If a group whitelist is explicitly configured, leave unlisted groups
  if (
    config.allowedChatIds.length > 0 &&
    (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') &&
    !config.allowedChatIds.includes(chatId)
  ) {
    try {
      await ctx.leaveChat();
    } catch {}
    return;
  }

  // Check user whitelist
  const fromId = ctx.from?.id;
  const hasUserWhitelist = config.allowedUserIds.length > 0 || config.adminUserIds.length > 0;

  if (hasUserWhitelist) {
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

      // In private chat, inform the user about access restriction and show their ID
      if (ctx.chat?.type === 'private') {
        await ctx.reply(
          `⛔ <b>Доступ ограничен.</b>\n\n` +
          `Ваш Telegram ID: <code>${fromId || 'неизвестен'}</code>.\n\n` +
          `Бот работает по списку разрешённых пользователей. Попросите администратора добавить ваш ID в список.`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      // In group chats, silently ignore messages from non-whitelisted users
      return;
    }
  }

  return next();
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
function renderListMessage(category: Category, items: TodoItem[], isGroup = false): string {
  const categoryTitle = category === 'shopping'
    ? (isGroup ? '🛒 Общий список покупок' : '🛒 Список покупок')
    : (isGroup ? '📝 Общий список дел' : '📝 Список дел и задач');
  const header = `<b>${categoryTitle}</b>\n\n`;

  if (items.length === 0) {
    const hint = isGroup
      ? '💡 Отправьте сообщение в группу или запишите голосовое, чтобы добавить пункты!'
      : '💡 Отправьте текст с пунктами или запишите голосовое, чтобы добавить их сюда!';
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

    if (item.is_done) {
      text += `<s>${icon} ${num} ${item.text}${item.quantity && item.quantity > 1 ? ` (${item.quantity} шт.)` : ''}</s>\n\n`;
    } else {
      text += `${icon} ${num} <b>${item.text}</b>${qtyText}\n\n`;
    }
  });

  text += `Осталось: <b>${activeItems.length}</b> | Выполнено: <b>${doneItems.length}</b>\n\n`;
  text += `<i>Управляйте пунктами, количеством и правками кнопками ниже:</i>`;

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
 * Renders or updates the interactive list card and navigation block for the current active list entity.
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

  const messageText = renderListMessage(targetCategory, items, isGroup);
  const keyboard = buildListKeyboard(targetCategory, items, stats);
  const navKeyboard = buildNavigationKeyboard(targetCategory, stats);
  const navText = '🗂 <b>Разделы списка:</b>';

  // If this update was triggered by an inline button interaction and both messages already exist,
  // edit them in-place rather than deleting and re-sending.
  if (editMessageId && activeList.last_message_id && activeList.nav_message_id) {
    try {
      await Promise.all([
        ctx.api.editMessageText(chatId, activeList.last_message_id, messageText, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        }).catch((e) => {
          if (!String(e?.message).includes('message is not modified')) {
            throw e;
          }
        }),
        ctx.api.editMessageReplyMarkup(chatId, activeList.nav_message_id, {
          reply_markup: navKeyboard,
        }).catch((e) => {
          if (!String(e?.message).includes('message is not modified')) {
            throw e;
          }
        }),
      ]);
      return;
    } catch (e: any) {
      console.warn('Failed in-place edit of list card/nav, will re-post:', e?.message || e);
    }
  }

  // Delete all previous list cards (including closed lists and previous active card and nav)
  const previousCardIds = await getAllListMessageIds(chatId, activeList.id);
  const oldActiveCardId = activeList.last_message_id;
  const oldActiveNavId = activeList.nav_message_id;
  if (oldActiveCardId && !previousCardIds.includes(oldActiveCardId)) {
    previousCardIds.push(oldActiveCardId);
  }
  if (oldActiveNavId && !previousCardIds.includes(oldActiveNavId)) {
    previousCardIds.push(oldActiveNavId);
  }

  if (previousCardIds.length > 0) {
    await deleteMessagesSafe(ctx, chatId, previousCardIds);
    await clearListMessageIds(chatId, previousCardIds);
  }

  // Send main list card message
  const sentCard = await ctx.reply(messageText, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });

  // Send category navigation message immediately beneath the list card
  const sentNav = await ctx.reply(navText, {
    parse_mode: 'HTML',
    reply_markup: navKeyboard,
  });

  await setListMessageIds(activeList.id, sentCard.message_id, sentNav.message_id);

  // Sweep any intermediate messages between previous cards position and new cards position
  const anchorOldId = Math.max(oldActiveCardId || 0, oldActiveNavId || 0);
  if (anchorOldId > 0 && anchorOldId < sentCard.message_id - 1) {
    const sweepRange: number[] = [];
    for (let id = anchorOldId + 1; id < sentCard.message_id; id++) {
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

  await ctx.reply(welcome, {
    parse_mode: 'HTML',
    reply_markup: { remove_keyboard: true },
  });
  await sendOrUpdateList(ctx, 'shopping');
});

bot.command('help', async (ctx) => {
  try { await ctx.deleteMessage(); } catch {}
  const helpText = `📖 <b>Справка по командам:</b>

/list — показать текущий активный список
/shopping — открыть 🛒 Список покупок
/tasks — открыть 📝 Список дел и задач
/expenses — 📊 дэшборд расходов (фильтры: 7, 14, 30 дней)
/clean — 🧹 удалить старые сообщения и закрытые списки до текущего
/clear — удалить выполненные пункты из активного списка
/close — 🏁 закрыть текущий список (следующее сообщение начнет новый список)
/export — экспортировать списки обычным текстом
/stats — посмотреть статистику активного списка

🧾 <b>Сканирование чеков и учет трат:</b>
• Просто отправьте в чат <b>фотографию чека</b>
• Бот распознает магазин, дату, сумму и все товары с ценами
• Купленные позиции автоматически отмечаются в вашем списке покупок
• Траты попадают в аналитический дэшборд (команда /expenses)

<b>Редактирование:</b>
• Кнопка «✏️ Управление списком» внизу карточки
• Или напишите: <code>измени 2 на ...</code> или <code>/edit 2 ...</code>`;

  await ctx.reply(helpText, {
    parse_mode: 'HTML',
    reply_markup: { remove_keyboard: true },
  });
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
  const targetNavId = activeList.nav_message_id;

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
      if (id !== targetCardId && id !== targetNavId) {
        sweepRange.push(id);
      }
    }
    if (sweepRange.length > 0) {
      await deleteMessagesSafe(ctx, chatId, sweepRange);
    }
  }

  // 3. Ensure the current active list is visible at the bottom
  if (!targetCardId || !targetNavId) {
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

bot.command(['close', 'finish'], async (ctx) => {
  try { await ctx.deleteMessage(); } catch {}
  const chatId = ctx.chat.id;
  const activeList = await getOrCreateActiveList(chatId);
  const stats = await getListStats(activeList.id);

  // Delete previous active list card and nav message on close
  if (activeList.last_message_id) {
    try {
      await ctx.api.deleteMessage(chatId, activeList.last_message_id);
    } catch {}
  }
  if (activeList.nav_message_id) {
    try {
      await ctx.api.deleteMessage(chatId, activeList.nav_message_id);
    } catch {}
  }

  const closedList = await closeActiveList(chatId);

  const total = stats.shoppingTotal + stats.taskTotal;
  const done = stats.shoppingDone + stats.taskDone;

  const sent = await ctx.reply(
    `🏁 <b>Список успешно закрыт!</b>\n\n` +
    `Всего было пунктов: <b>${total}</b> (выполнено: <b>${done}</b>)\n\n` +
    `💡 <i>Следующее сообщение с покупками или делами создаст новый список.</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { remove_keyboard: true },
    }
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

bot.command(['expenses', 'spending', 'analytics', 'finance'], async (ctx) => {
  try { await ctx.deleteMessage(); } catch {}
  const chatId = ctx.chat.id;
  const isGroup = ctx.chat.type !== 'private';
  const text = await renderExpensesDashboard(chatId, '7d', 'overview', isGroup);
  const keyboard = buildExpensesKeyboard('7d', 'overview', isGroup);

  await ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
});

bot.command(['receipts', 'checks', 'cheques'], async (ctx) => {
  try { await ctx.deleteMessage(); } catch {}
  const chatId = ctx.chat.id;
  const isGroup = ctx.chat.type !== 'private';
  const receipts = await getRecentReceipts(chatId, 10);
  const text = renderReceiptsList(receipts, isGroup);
  const keyboard = buildReceiptsListKeyboard(receipts);

  await ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
});

bot.command(['receipt', 'check'], async (ctx) => {
  try { await ctx.deleteMessage(); } catch {}
  const chatId = ctx.chat.id;
  const isGroup = ctx.chat.type !== 'private';
  const rawText = ctx.message?.text?.trim() || '';
  const match = rawText.match(/^\/(?:receipt|check)\s+(\d+)$/i);

  if (!match) {
    const receipts = await getRecentReceipts(chatId, 10);
    const text = renderReceiptsList(receipts, isGroup);
    const keyboard = buildReceiptsListKeyboard(receipts);
    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    return;
  }

  const receiptId = Number(match[1]);
  const receipt = await getReceiptById(receiptId);
  if (!receipt || receipt.chat_id !== chatId) {
    await ctx.reply(`❌ Чек #${receiptId} не найден в этом чате.`);
    return;
  }

  const card = renderReceiptCard(receipt, [], isGroup);
  const keyboard = buildReceiptDetailKeyboard(receipt.id);
  await ctx.reply(card, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
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

  // 0. Handle persistent bottom navigation buttons (and dismiss keyboard if tapped)
  if (/^(?:👉\s*)?🛒\s*Покупки/i.test(rawText)) {
    try { await ctx.deleteMessage(); } catch {}
    const rm = await ctx.reply('🔄', { reply_markup: { remove_keyboard: true } });
    try { await ctx.api.deleteMessage(chatId, rm.message_id); } catch {}
    await sendOrUpdateList(ctx, 'shopping');
    return;
  }
  if (/^(?:👉\s*)?📝\s*Дела/i.test(rawText)) {
    try { await ctx.deleteMessage(); } catch {}
    const rm = await ctx.reply('🔄', { reply_markup: { remove_keyboard: true } });
    try { await ctx.api.deleteMessage(chatId, rm.message_id); } catch {}
    await sendOrUpdateList(ctx, 'task');
    return;
  }

  // 1. Check if user is in an active item text edit prompt
  if (pendingEdits.has(chatId)) {
    const edit = pendingEdits.get(chatId)!;
    pendingEdits.delete(chatId);

    if (edit.promptMsgId) {
      try { await ctx.api.deleteMessage(chatId, edit.promptMsgId); } catch {}
    }
    try { await ctx.deleteMessage(); } catch {}

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
    reply_markup: { remove_keyboard: true },
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
    reply_markup: { remove_keyboard: true },
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

// ---------------- RECEIPT PHOTO AND DOCUMENT PROCESSING ---------------- //

/**
 * Safely edits a message with HTML formatting. If Telegram rejects HTML entities (e.g. unescaped tags),
 * falls back to plain text. If editing fails completely (message missing/deleted/stale), sends a new reply message.
 */
async function safeEditOrReply(
  ctx: any,
  chatId: number,
  messageId: number,
  htmlText: string,
  extra?: any
): Promise<void> {
  try {
    await ctx.api.editMessageText(chatId, messageId, htmlText, {
      parse_mode: 'HTML',
      ...extra,
    });
    return;
  } catch (err: any) {
    const errMsg = String(err?.message || '');
    // If Telegram returned entity parse error or modify error, attempt plain text edit
    try {
      const plainText = htmlText.replace(/<[^>]*>/g, '');
      await ctx.api.editMessageText(chatId, messageId, plainText, extra);
      return;
    } catch {
      // If editing failed completely, reply with a fresh message
      try {
        await ctx.reply(htmlText, { parse_mode: 'HTML', ...extra });
      } catch {
        const plainText = htmlText.replace(/<[^>]*>/g, '');
        await ctx.reply(plainText, extra);
      }
    }
  }
}

bot.on(['message:photo', 'message:document'], async (ctx) => {
  const photoArray = ctx.message.photo;
  const document = ctx.message.document;

  let fileId: string | null = null;
  let mimeType = 'image/jpeg';

  if (photoArray && photoArray.length > 0) {
    const highestRes = photoArray[photoArray.length - 1];
    fileId = highestRes.file_id;
    mimeType = 'image/jpeg';
  } else if (document) {
    const docMime = document.mime_type || '';
    if (docMime.startsWith('image/')) {
      fileId = document.file_id;
      mimeType = docMime;
    }
  }

  if (!fileId) return;

  const chatId = ctx.chat.id;
  const fromUser = ctx.from;
  const isGroup = ctx.chat.type !== 'private';
  const userName = fromUser ? (fromUser.first_name || fromUser.username || `User_${fromUser.id}`) : 'Пользователь';

  console.log(`[Receipt] Received photo/doc from user ${fromUser?.id} (${userName}) in chat ${chatId}`);

  // 1. Send immediate receipt status feedback
  const statusMsg = await ctx.reply('🧾 <b>Фотография чека получена!</b>\n⏳ <i>Подготовка к обработке...</i>', {
    parse_mode: 'HTML',
    reply_markup: { remove_keyboard: true },
  });

  if (!config.isAiEnabled) {
    await safeEditOrReply(
      ctx,
      chatId,
      statusMsg.message_id,
      '❌ <b>Gemini AI не подключен!</b>\n\n' +
      'Для сканирования чеков требуется добавить <code>GEMINI_API_KEY</code> в файл <code>.env</code> на сервере и перезапустить бота.'
    );
    return;
  }

  ctx.replyWithChatAction('upload_photo').catch(() => {});

  try {
    // 2. Download photo from Telegram API
    await safeEditOrReply(
      ctx,
      chatId,
      statusMsg.message_id,
      '🧾 <b>Фотография чека принята!</b>\n⏳ <i>Скачиваю изображение из Telegram...</i>'
    );

    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) {
      await safeEditOrReply(
        ctx,
        chatId,
        statusMsg.message_id,
        '❌ Не удалось получить путь к изображению от Telegram API.'
      );
      return;
    }

    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const res = await fetch(fileUrl, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      await safeEditOrReply(
        ctx,
        chatId,
        statusMsg.message_id,
        `❌ Ошибка скачивания фото чека: ${res.status} ${res.statusText}`
      );
      return;
    }

    const arrayBuffer = await res.arrayBuffer();
    const sizeKb = Math.round(arrayBuffer.byteLength / 1024);
    const base64Image = Buffer.from(arrayBuffer).toString('base64');

    console.log(`[Receipt] Image downloaded (${sizeKb} KB). Passing to Gemini Vision...`);

    await safeEditOrReply(
      ctx,
      chatId,
      statusMsg.message_id,
      `📥 <b>Изображение получено (${sizeKb} КБ)</b>\n⏳ <i>Отправляю в нейросеть Gemini AI...</i>`
    );

    const onProgress = async (text: string) => {
      await safeEditOrReply(ctx, chatId, statusMsg.message_id, text);
    };

    // 3. Scan receipt with Gemini
    const scanResult = await scanReceiptWithGemini(base64Image, mimeType, onProgress);

    if (!scanResult.success || !scanResult.items || scanResult.items.length === 0) {
      console.warn(`[Receipt] Scan failed or zero items: ${scanResult.error}`);
      const safeErr = escapeHtml(scanResult.error || 'Товары не найдены на изображении.');
      await safeEditOrReply(
        ctx,
        chatId,
        statusMsg.message_id,
        `⚠️ <b>Не удалось распознать чек:</b>\n${safeErr}\n\n` +
        `💡 <i>Убедитесь, что чек сфотографирован чётко, вертикально и при хорошем освещении.</i>`
      );
      return;
    }

    await onProgress('💾 <b>Чек распознан!</b>\n⏳ <i>Сохраняю данные в базу и сверяю покупки...</i>');

    // 4. Save receipt and items to database
    const savedReceipt = await addReceipt(
      chatId,
      fromUser ? fromUser.id : 0,
      userName,
      scanResult.storeName,
      scanResult.receiptDate || new Date().toISOString(),
      scanResult.totalAmount || 0,
      scanResult.items,
      scanResult.rawText
    );

    console.log(`[Receipt] Successfully saved receipt #${savedReceipt.id} (${savedReceipt.items_count} items, ${savedReceipt.total_amount} ₽)`);

    // 5. Auto-match bought items with active shopping list
    const activeList = await getOrCreateActiveList(chatId);
    const boughtNames = scanResult.items.map((i) => i.name);
    const matchedShoppingItems = await markMatchingShoppingItemsDone(chatId, activeList.id, boughtNames);

    // 6. Delete incoming user photo message to keep chat clean (if bot has permissions)
    try {
      await ctx.deleteMessage();
    } catch {}

    // 7. Render full itemized digital receipt card
    const cardText = renderReceiptCard(savedReceipt, matchedShoppingItems, isGroup);

    // Replace status message with the completed receipt card
    await safeEditOrReply(ctx, chatId, statusMsg.message_id, cardText, {
      reply_markup: buildReceiptCardKeyboard(savedReceipt.id),
    });

    // If active shopping list was modified, also update the main shopping list card
    if (matchedShoppingItems.length > 0 && activeList.last_message_id) {
      try {
        await sendOrUpdateList(ctx, 'shopping', activeList.last_message_id);
      } catch {}
    }
  } catch (error: any) {
    console.error('[Receipt] Error handling receipt photo message:', error);
    const safeErr = escapeHtml(error?.message || String(error));
    const errorMsg = `❌ <b>Ошибка при обработке фото чека:</b>\n<code>${safeErr}</code>\n\n` +
      `💡 <i>Если ошибка повторяется, проверьте доступность Gemini AI и сетевое соединение.</i>`;
    await safeEditOrReply(ctx, chatId, statusMsg.message_id, errorMsg);
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

    // Remove the separate navigation message so only the closed summary remains
    if (activeList.nav_message_id) {
      try {
        await ctx.api.deleteMessage(chatId, activeList.nav_message_id);
      } catch {}
    }

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

  // Open expenses dashboard: exp_open:<period>
  if (data.startsWith('exp_open:')) {
    const period = (data.split(':')[1] as PeriodFilter) || '7d';
    const isGroup = ctx.chat?.type !== 'private';
    const text = await renderExpensesDashboard(chatId, period, 'overview', isGroup);
    const keyboard = buildExpensesKeyboard(period, 'overview', isGroup);
    await ctx.answerCallbackQuery();
    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    return;
  }

  // Switch expenses period filter: exp_period:<period>:<tab>
  if (data.startsWith('exp_period:')) {
    const parts = data.split(':');
    const period = (parts[1] as PeriodFilter) || '7d';
    const tab = (parts[2] as ExpensesTab) || 'overview';
    const isGroup = ctx.chat?.type !== 'private';

    let recentReceiptIds: number[] = [];
    if (tab === 'receipts') {
      const receipts = await getRecentReceipts(chatId, 6);
      recentReceiptIds = receipts.map((r) => r.id);
    }

    const text = await renderExpensesDashboard(chatId, period, tab, isGroup);
    const keyboard = buildExpensesKeyboard(period, tab, isGroup, recentReceiptIds);

    await ctx.answerCallbackQuery();
    try {
      await ctx.api.editMessageText(chatId, messageId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (e: any) {
      if (!String(e?.message).includes('message is not modified')) {
        console.error('Failed to edit expenses period:', e);
      }
    }
    return;
  }

  // Switch expenses tab: exp_tab:<period>:<tab>
  if (data.startsWith('exp_tab:')) {
    const parts = data.split(':');
    const period = (parts[1] as PeriodFilter) || '7d';
    const tab = (parts[2] as ExpensesTab) || 'overview';
    const isGroup = ctx.chat?.type !== 'private';

    let recentReceiptIds: number[] = [];
    if (tab === 'receipts') {
      const receipts = await getRecentReceipts(chatId, 6);
      recentReceiptIds = receipts.map((r) => r.id);
    }

    const text = await renderExpensesDashboard(chatId, period, tab, isGroup);
    const keyboard = buildExpensesKeyboard(period, tab, isGroup, recentReceiptIds);

    await ctx.answerCallbackQuery();
    try {
      await ctx.api.editMessageText(chatId, messageId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (e: any) {
      if (!String(e?.message).includes('message is not modified')) {
        console.error('Failed to edit expenses tab:', e);
      }
    }
    return;
  }

  // Refresh expenses dashboard: exp_refresh:<period>:<tab>
  if (data.startsWith('exp_refresh:')) {
    const parts = data.split(':');
    const period = (parts[1] as PeriodFilter) || '7d';
    const tab = (parts[2] as ExpensesTab) || 'overview';
    const isGroup = ctx.chat?.type !== 'private';

    let recentReceiptIds: number[] = [];
    if (tab === 'receipts') {
      const receipts = await getRecentReceipts(chatId, 6);
      recentReceiptIds = receipts.map((r) => r.id);
    }

    const text = await renderExpensesDashboard(chatId, period, tab, isGroup);
    const keyboard = buildExpensesKeyboard(period, tab, isGroup, recentReceiptIds);

    await ctx.answerCallbackQuery({ text: 'Данные обновлены 🔄' });
    try {
      await ctx.api.editMessageText(chatId, messageId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (e: any) {
      if (!String(e?.message).includes('message is not modified')) {
        console.error('Failed to refresh expenses:', e);
      }
    }
    return;
  }

  // Delete receipt: exp_del_receipt:<id>:<period>
  if (data.startsWith('exp_del_receipt:')) {
    const parts = data.split(':');
    const receiptId = Number(parts[1]);
    const period = (parts[2] as PeriodFilter) || '7d';
    const isGroup = ctx.chat?.type !== 'private';

    if (receiptId > 0) {
      await deleteReceipt(chatId, receiptId);
      await ctx.answerCallbackQuery({ text: `Чек #${receiptId} удалён 🗑` });
    } else {
      await ctx.answerCallbackQuery();
    }

    // Refresh receipts tab or card
    const receipts = await getRecentReceipts(chatId, 6);
    const recentReceiptIds = receipts.map((r) => r.id);
    const text = await renderExpensesDashboard(chatId, period, 'receipts', isGroup);
    const keyboard = buildExpensesKeyboard(period, 'receipts', isGroup, recentReceiptIds);

    await safeEditOrReply(ctx, chatId, messageId, text, {
      reply_markup: keyboard,
    });
    return;
  }

  // View single receipt detail: view_receipt:<id>[:period]
  if (data.startsWith('view_receipt:')) {
    const parts = data.split(':');
    const receiptId = Number(parts[1]);
    const period = (parts[2] as PeriodFilter) || '7d';
    const isGroup = ctx.chat?.type !== 'private';

    const receipt = await getReceiptById(receiptId);
    if (!receipt || receipt.chat_id !== chatId) {
      await ctx.answerCallbackQuery({ text: 'Чек не найден в этом чате' });
      return;
    }

    await ctx.answerCallbackQuery();
    const card = renderReceiptCard(receipt, [], isGroup);
    const keyboard = buildReceiptDetailKeyboard(receipt.id, period);

    await safeEditOrReply(ctx, chatId, messageId, card, {
      reply_markup: keyboard,
    });
    return;
  }

  // View all receipts list: view_all_receipts
  if (data === 'view_all_receipts') {
    const isGroup = ctx.chat?.type !== 'private';
    const receipts = await getRecentReceipts(chatId, 10);
    const text = renderReceiptsList(receipts, isGroup);
    const keyboard = buildReceiptsListKeyboard(receipts);

    await ctx.answerCallbackQuery();
    await safeEditOrReply(ctx, chatId, messageId, text, {
      reply_markup: keyboard,
    });
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
      { command: 'shopping', description: '🛒 Список покупок' },
      { command: 'tasks', description: '📝 Список дел' },
      { command: 'expenses', description: '📊 Траты и чеки (7, 14, 30 дн)' },
      { command: 'receipts', description: '🧾 История чеков и товаров' },
      { command: 'clear', description: '🧹 Удалить выполненные' },
      { command: 'close', description: '🏁 Закрыть список' },
      { command: 'export', description: '📋 Экспорт текстом' },
      { command: 'stats', description: '📊 Статистика списка' },
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
