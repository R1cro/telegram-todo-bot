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
  toggleItemDone,
  clearCompletedFromList,
  clearCategoryFromList,
  getListStats,
  type Category,
  type TodoItem,
} from './db.js';
import { parseMessage } from './parser.js';
import {
  buildListKeyboard,
  buildConfirmClearKeyboard,
  buildConfirmFinishKeyboard,
} from './keyboards.js';

validateConfig();

export const bot = new Bot(config.botToken);

// Conversational chatter stop-words to ignore in group chats to avoid reacting to casual talk
const CHAT_STOP_WORDS = /^(привет|хай|ку|здравствуйте|добрый день|как дела|ок|окей|ok|хорошо|ладно|понял|понятно|пон|спасибо|спс|спасиб|благодарю|да|нет|неа|ага|я дома|я скоро|я выехал|я на месте|пока|доброе утро|спокойной ночи|отлично|лол|кек|хаха|ха-ха|круто|класс|ясно|точно|согласен|плюс|минус|\?|!|\.|\+|-)$/iu;

function isConversationalNoise(text: string): boolean {
  const clean = text.trim().toLowerCase().replace(/[.,!?;:()«»"']+/g, '').trim();
  return CHAT_STOP_WORDS.test(clean) || clean.length <= 1;
}

/**
 * Formats the HTML text representation of the current list.
 */
function renderListMessage(category: Category, items: TodoItem[], isGroup = false): string {
  const categoryTitle = category === 'shopping'
    ? (isGroup ? '🛒 Общий список покупок' : '🛒 Список покупок')
    : (isGroup ? '📝 Общий список дел' : '📝 Список дел и задач');
  const header = `<b>${categoryTitle}</b>\n\n`;

  if (items.length === 0) {
    const hint = isGroup
      ? '💡 Отправьте сообщение в группу, чтобы добавить пункты в этот список!'
      : '💡 Отправьте текст с пунктами (через запятую, с новой строки или фразой), чтобы добавить их сюда!';
    return `${header}<i>Список пока пуст.</i>\n\n${hint}`;
  }

  const activeItems = items.filter((i) => !i.is_done);
  const doneItems = items.filter((i) => i.is_done);

  let text = header;
  text += `Осталось: <b>${activeItems.length}</b> | Выполнено: <b>${doneItems.length}</b>\n\n`;
  text += `<i>Нажмите на пункт в кнопках ниже, чтобы вычеркнуть или вернуть его.</i>`;

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

  const sent = await ctx.reply(messageText, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
  await setListLastMessageId(activeList.id, sent.message_id);
}

// ---------------- COMMAND HANDLERS ---------------- //

bot.command('start', async (ctx) => {
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
• Просто пишите сообщение: <code>молоко, хлеб, сыр</code>
• Или построчно со знаками <code>-</code> или цифрами
• Или свободным текстом

Управляйте активным списком кнопками ниже 👇`;

  await ctx.reply(welcome, { parse_mode: 'HTML' });
  await sendOrUpdateList(ctx, 'shopping');
});

bot.command('help', async (ctx) => {
  const helpText = `📖 <b>Справка по командам:</b>

/list — показать текущий активный список
/shopping — открыть 🛒 Список покупок
/tasks — открыть 📝 Список дел и задач
/clear — удалить выполненные пункты из активного списка
/close — 🏁 закрыть текущий список (следующее сообщение начнет новый список)
/export — экспортировать списки обычным текстом
/stats — посмотреть статистику активного списка

<b>Принцип работы:</b>
Список живет как активная сущность. Любые сообщения дополняют его. Когда вы закончили покупки или дела, нажмите <b>«🏁 Закрыть список»</b>, и новый цикл начнется с чистого листа.`;

  await ctx.reply(helpText, { parse_mode: 'HTML' });
});

bot.command(['list', 'menu'], async (ctx) => {
  await sendOrUpdateList(ctx);
});

bot.command(['shopping', 'buy'], async (ctx) => {
  await sendOrUpdateList(ctx, 'shopping');
});

bot.command(['tasks', 'todo'], async (ctx) => {
  await sendOrUpdateList(ctx, 'task');
});

bot.command('clear', async (ctx) => {
  const chatId = ctx.chat.id;
  const user = await getOrCreateUser(chatId);
  const activeList = await getOrCreateActiveList(chatId);
  const deleted = await clearCompletedFromList(activeList.id, user.active_category);

  const categoryName = user.active_category === 'shopping' ? 'покупок' : 'дел';
  if (deleted > 0) {
    await ctx.reply(`🧹 Удалено выполненных пунктов из ${categoryName}: <b>${deleted}</b>`, {
      parse_mode: 'HTML',
    });
  } else {
    await ctx.reply(`В списке ${categoryName} нет выполненных пунктов для удаления.`);
  }

  await sendOrUpdateList(ctx, user.active_category);
});

bot.command(['close', 'finish'], async (ctx) => {
  const chatId = ctx.chat.id;
  const activeList = await getOrCreateActiveList(chatId);
  const stats = await getListStats(activeList.id);

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
    text += '<b>🛒 Список покупок:</b>\n';
    for (const item of shoppingItems) {
      const mark = item.is_done ? '<s>[x]' : '[ ]';
      const endMark = item.is_done ? '</s>' : '';
      text += `${mark} ${item.text}${endMark}\n`;
    }
    text += '\n';
  }

  if (taskItems.length > 0) {
    text += '<b>📝 Список дел:</b>\n';
    for (const item of taskItems) {
      const mark = item.is_done ? '<s>[x]' : '[ ]';
      const endMark = item.is_done ? '</s>' : '';
      text += `${mark} ${item.text}${endMark}\n`;
    }
  }

  await ctx.reply(text, { parse_mode: 'HTML' });
});

bot.command('stats', async (ctx) => {
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

  await ctx.replyWithChatAction('typing');

  const parsedItems = await parseMessage(rawText, user.active_category);

  if (parsedItems.length === 0) {
    if (!isGroup) {
      await ctx.reply('Не удалось распознать пункты. Отправьте список через запятую или построчно.');
    }
    return;
  }

  // Always append items to the currently active list entity
  const activeList = await getOrCreateActiveList(chatId);

  await addItems(
    activeList.id,
    chatId,
    parsedItems.map((p) => ({
      category: p.category,
      text: p.text,
    }))
  );

  const shoppingAdded = parsedItems.filter((i) => i.category === 'shopping');
  const tasksAdded = parsedItems.filter((i) => i.category === 'task');
  const primaryCategory = tasksAdded.length > shoppingAdded.length ? 'task' : 'shopping';

  let report = '✅ <b>Добавлено:</b>\n';
  if (shoppingAdded.length > 0) {
    report += `🛒 В покупки (${shoppingAdded.length}): <i>${shoppingAdded.map((i) => i.text).join(', ')}</i>\n`;
  }
  if (tasksAdded.length > 0) {
    report += `📝 В дела (${tasksAdded.length}): <i>${tasksAdded.map((i) => i.text).join(', ')}</i>\n`;
  }

  const parserBadge = parsedItems[0]?.extractedBy === 'ai' ? ' <i>(✨ AI)</i>' : '';
  report += parserBadge;

  // If the active list already had an open Telegram card message, edit it in-place
  let updatedExistingMessage = false;
  if (activeList.last_message_id) {
    try {
      const [updatedItems, stats] = await Promise.all([
        getListItems(activeList.id, primaryCategory),
        getListStats(activeList.id),
      ]);
      const messageText = renderListMessage(primaryCategory, updatedItems, isGroup);
      const keyboard = buildListKeyboard(primaryCategory, updatedItems, stats);

      await ctx.api.editMessageText(chatId, activeList.last_message_id, messageText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      updatedExistingMessage = true;
    } catch (e: any) {
      updatedExistingMessage = false;
    }
  }

  if (updatedExistingMessage) {
    report += '\n🔄 <i>Текущий список дополнен и обновлен выше!</i>';
    await ctx.reply(report, { parse_mode: 'HTML' });
  } else {
    await ctx.reply(report, { parse_mode: 'HTML' });
    await sendOrUpdateList(ctx, primaryCategory);
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
      text += `${check} ${item.text}${end}\n`;
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
