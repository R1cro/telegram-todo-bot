import { Bot, Context, InlineKeyboard } from 'grammy';
import { config, validateConfig } from './config.js';
import {
  initDatabase,
  getOrCreateUser,
  setUserCategory,
  getOrCreateActiveList,
  closeActiveList,
  setListLastMessageId,
  addItems,
  getListItems,
  getItemById,
  updateItemQuantity,
  updateItemText,
  toggleItemDone,
  clearCompletedFromList,
  clearCategoryFromList,
  getListStats,
  type Category,
  type TodoItem,
} from './db.js';
import { parseMessage, parseVoiceWithGemini, extractQuantity } from './parser.js';
import {
  buildListKeyboard,
  buildConfirmClearKeyboard,
  buildConfirmFinishKeyboard,
  buildCancelEditKeyboard,
} from './keyboards.js';

validateConfig();

export const bot = new Bot(config.botToken);

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
    const icon = item.is_done ? '✅' : '⬜';
    const num = `${index + 1}.`;
    const qtyText = item.quantity && item.quantity > 1
      ? ` — <b>${item.quantity} шт.</b>`
      : (category === 'shopping' ? ` — <b>${item.quantity || 1} шт.</b>` : '');

    if (item.is_done) {
      text += `<s>${icon} ${num} ${item.text}${qtyText ? ` (${item.quantity || 1} шт.)` : ''}</s>\n\n`;
    } else {
      text += `${icon} ${num} <b>${item.text}</b>${qtyText}\n\n`;
    }
  });

  text += `Осталось: <b>${activeItems.length}</b> | Выполнено: <b>${doneItems.length}</b>\n\n`;
  text += `<i>Управляйте пунктами, количеством и правками кнопками ниже:</i>`;

  return text;
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

  const messageText = renderListMessage(targetCategory, items, isGroup);
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

  // Delete previous list card message if present so there is only ever one active list message
  if (activeList.last_message_id && activeList.last_message_id !== editMessageId) {
    try {
      await ctx.api.deleteMessage(chatId, activeList.last_message_id);
    } catch {
      // Previous message may already have been deleted
    }
  }

  const sent = await ctx.reply(messageText, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
  await setListLastMessageId(activeList.id, sent.message_id);
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

  await ctx.reply(welcome, { parse_mode: 'HTML' });
  await sendOrUpdateList(ctx, 'shopping');
});

bot.command('help', async (ctx) => {
  try { await ctx.deleteMessage(); } catch {}
  const helpText = `📖 <b>Справка по командам:</b>

/list — показать текущий активный список
/shopping — открыть 🛒 Список покупок
/tasks — открыть 📝 Список дел и задач
/clear — удалить выполненные пункты из активного списка
/close — 🏁 закрыть текущий список (следующее сообщение начнет новый список)
/export — экспортировать списки обычным текстом
/stats — посмотреть статистику активного списка

<b>Редактирование:</b>
• Кнопка «✏️ Правка» под любым пунктом
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

  await closeActiveList(chatId);

  const total = stats.shoppingTotal + stats.taskTotal;
  const done = stats.shoppingDone + stats.taskDone;

  await ctx.reply(
    `🏁 <b>Список успешно закрыт!</b>\n\n` +
    `Всего было пунктов: <b>${total}</b> (выполнено: <b>${done}</b>)\n\n` +
    `💡 <i>Следующее сообщение с покупками или делами создаст новый список.</i>`,
    { parse_mode: 'HTML' }
  );
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

  await ctx.replyWithChatAction('typing');

  const parsedItems = await parseMessage(rawText, user.active_category);

  if (parsedItems.length === 0) {
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

  // Increment item quantity: qty_inc:<id>
  if (data.startsWith('qty_inc:')) {
    const itemId = Number(data.split(':')[1]);
    const newQty = await updateItemQuantity(chatId, itemId, +1);
    await ctx.answerCallbackQuery({ text: `Количество: ${newQty} шт.` });
    const user = await getOrCreateUser(chatId);
    await sendOrUpdateList(ctx, user.active_category, messageId);
    return;
  }

  // Decrement item quantity: qty_dec:<id>
  if (data.startsWith('qty_dec:')) {
    const itemId = Number(data.split(':')[1]);
    const newQty = await updateItemQuantity(chatId, itemId, -1);
    await ctx.answerCallbackQuery({ text: `Количество: ${newQty} шт.` });
    const user = await getOrCreateUser(chatId);
    await sendOrUpdateList(ctx, user.active_category, messageId);
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
    await closeActiveList(chatId);

    await ctx.answerCallbackQuery({ text: 'Список закрыт! 🏁' });

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
      const check = item.is_done ? '<s>☑️' : '⬜';
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
      { command: 'shopping', description: '🛒 Список покупок' },
      { command: 'tasks', description: '📝 Список дел' },
      { command: 'clear', description: '🧹 Удалить выполненные' },
      { command: 'close', description: '🏁 Закрыть список' },
      { command: 'export', description: '📋 Экспорт текстом' },
      { command: 'stats', description: '📊 Статистика' },
      { command: 'help', description: '📖 Справка и помощь' },
    ]);
  } catch (e) {
    console.warn('Could not register bot commands menu with Telegram API.');
  }

  bot.start({
    onStart: (botInfo) => {
      console.log(`Bot @${botInfo.username} is running and ready!`);
    },
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
});
