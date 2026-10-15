import { Bot, Context, InlineKeyboard } from 'grammy';
import { config, validateConfig } from './config.js';
import {
  initDatabase,
  getOrCreateUser,
  setUserCategory,
  setLastListMessageId,
  getLastListMessageId,
  isListCompleted,
  addItems,
  getItems,
  toggleItemDone,
  clearCompletedItems,
  clearAllCategoryItems,
  getStats,
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

// Список чисто разговорных фраз для игнорирования в групповом чате (чтобы не реагировать на флуд)
const CHAT_STOP_WORDS = /^(привет|хай|ку|здравствуйте|добрый день|как дела|ок|окей|ok|хорошо|ладно|понял|понятно|пон|спасибо|спс|спасиб|благодарю|да|нет|неа|ага|я дома|я скоро|я выехал|я на месте|пока|доброе утро|спокойной ночи|отлично|лол|кек|хаха|ха-ха|круто|класс|ясно|точно|согласен|плюс|минус|\?|!|\.|\+|-)$/iu;

function isConversationalNoise(text: string): boolean {
  const clean = text.trim().toLowerCase().replace(/[.,!?;:()«»"']+/g, '').trim();
  return CHAT_STOP_WORDS.test(clean) || clean.length <= 1;
}

/**
 * Формирует текстовое сообщение со списком
 */
function renderListMessage(category: Category, items: TodoItem[], isGroup = false): string {
  const categoryTitle = category === 'shopping'
    ? (isGroup ? '🛒 Общий список покупок' : '🛒 Список покупок')
    : (isGroup ? '📝 Общий список дел' : '📝 Список дел и задач');
  const header = `<b>${categoryTitle}</b>\n\n`;

  if (items.length === 0) {
    const hint = isGroup
      ? '💡 Отправьте в группу сообщение (например: <code>купить сыр, хлеб</code>), чтобы добавить пункты в общий список!'
      : '💡 Просто отправьте мне сообщение с текстом (через запятую, с новой строки или обычной фразой), и я добавлю пункты сюда!';
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
 * Отправляет или обновляет карточку со списком
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

  const [items, stats] = await Promise.all([
    getItems(chatId, targetCategory),
    getStats(chatId),
  ]);

  const messageText = renderListMessage(targetCategory, items, isGroup);
  const keyboard = buildListKeyboard(targetCategory, items, stats);

  if (editMessageId) {
    try {
      await ctx.api.editMessageText(chatId, editMessageId, messageText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      await setLastListMessageId(chatId, editMessageId);
      return;
    } catch (e: any) {
      // Игнорируем ошибку Telegram "message is not modified"
      if (!String(e?.message).includes('message is not modified')) {
        console.error('Ошибка редактирования сообщения:', e);
      }
    }
  }

  const sent = await ctx.reply(messageText, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
  await setLastListMessageId(chatId, sent.message_id);
}

// ---------------- КОМАНДЫ ---------------- //

bot.command('start', async (ctx) => {
  const chatId = ctx.chat.id;
  await getOrCreateUser(chatId, ctx.from?.username, ctx.from?.first_name);

  const aiStatus = config.isAiEnabled
    ? '✨ <b>AI-распознавание (Gemini):</b> включено'
    : '⚙️ <b>Парсер:</b> быстрый локальный (без AI-ключа)';

  const welcome = `👋 <b>Привет! Я бот для покупок и дел.</b>

Я умею читать обычные сообщения и автоматически создавать из них список покупок или задач.

${aiStatus}

<b>Как со мной работать:</b>
• Отправьте список через запятую:
  <code>молоко, хлеб, сливочное масло, чай</code>
• Или построчно со знаками <code>-</code> или цифрами:
  <code>1. Заехать на автомойку</code>
  <code>2. Забрать посылку</code>
• Или свободной речью:
  <code>Завтра нужно купить корм коту и позвонить врачу</code>
• Или с префиксом категории:
  <code>Покупки: сыр, помидоры</code>
  <code>Дела: оплатить интернет, отправить отчет</code>

Управляйте списками кнопками ниже 👇`;

  await ctx.reply(welcome, { parse_mode: 'HTML' });
  await sendOrUpdateList(ctx, 'shopping');
});

bot.command('help', async (ctx) => {
  const helpText = `📖 <b>Справка по командам:</b>

/list — показать текущий активный список
/shopping — открыть 🛒 Список покупок
/tasks — открыть 📝 Список дел и задач
/clear — удалить выполненные пункты
/close — 🏁 закрыть и зафиксировать текущий список
/export — экспортировать списки обычным текстом
/stats — посмотреть статистику покупок и дел

<b>Как добавлять записи:</b>
Просто пишите мне текст сообщениями. Бот автоматически определит:
• Товары и продукты отправятся в <b>🛒 Покупки</b>
• Действия и поручения отправятся в <b>📝 Дела</b>

Клик по кнопке с пунктом переключает статус (⬜ ↔ ✅).`;

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
  const deleted = await clearCompletedItems(chatId, user.active_category);

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

bot.command('export', async (ctx) => {
  const chatId = ctx.chat.id;
  const [shoppingItems, taskItems] = await Promise.all([
    getItems(chatId, 'shopping'),
    getItems(chatId, 'task'),
  ]);

  if (shoppingItems.length === 0 && taskItems.length === 0) {
    await ctx.reply('Ваши списки пока пусты! Отправьте мне текст, чтобы добавить пункты.');
    return;
  }

  let text = '📋 <b>Ваши списки:</b>\n\n';

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
  const stats = await getStats(chatId);

  const statsText = `📊 <b>Статистика ваших списков:</b>

🛒 <b>Покупки:</b>
• Всего: ${stats.shoppingTotal}
• Куплено: ${stats.shoppingDone}
• Осталось купить: ${stats.shoppingTotal - stats.shoppingDone}

📝 <b>Дела и задачи:</b>
• Всего: ${stats.taskTotal}
• Выполнено: ${stats.taskDone}
• В процессе: ${stats.taskTotal - stats.taskDone}`;

  await ctx.reply(statsText, { parse_mode: 'HTML' });
});

bot.command(['close', 'finish'], async (ctx) => {
  const chatId = ctx.chat.id;
  const user = await getOrCreateUser(chatId);
  const category = user.active_category;
  const stats = await getStats(chatId);

  const total = category === 'shopping' ? stats.shoppingTotal : stats.taskTotal;
  const done = category === 'shopping' ? stats.shoppingDone : stats.taskDone;

  await clearAllCategoryItems(chatId, category);
  await setLastListMessageId(chatId, null);

  const title = category === 'shopping' ? '🛒 Список покупок' : '📝 Список дел';
  await ctx.reply(
    `🏁 <b>${title} закрыт!</b>\n\n` +
    `Было пунктов: <b>${total}</b> (выполнено: <b>${done}</b>)\n\n` +
    `💡 <i>Отправьте новое сообщение в чат, чтобы начать новый список.</i>`,
    { parse_mode: 'HTML' }
  );
});

// ---------------- ОБРАБОТКА ТЕКСТОВЫХ СООБЩЕНИЙ ---------------- //

bot.on('message:text', async (ctx) => {
  let rawText = ctx.message.text.trim();
  if (rawText.startsWith('/')) return; // Команды обрабатываются отдельно

  const chatId = ctx.chat.id;
  const isGroup = ctx.chat.type !== 'private';
  const botUsername = ctx.me.username;

  // Проверяем, упомянут ли бот в сообщении (например, @botname молоко, сыр)
  const isMentioned = Boolean(botUsername && rawText.includes(`@${botUsername}`));
  if (isMentioned && botUsername) {
    rawText = rawText.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim();
  }

  // Проверяем, является ли сообщение ответом на сообщение бота
  const isReplyToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;

  // В группе отсекаем только явный разговорный флуд ("привет", "ок", "я скоро буду", и т.п.),
  // если сообщение не адресовано напрямую боту
  if (isGroup && !isMentioned && !isReplyToBot) {
    if (isConversationalNoise(rawText)) {
      return; // Игнорируем обычный диалог в группе
    }
  }

  if (!rawText) return;

  const chatDisplayName = isGroup ? (ctx.chat.title || 'Группа') : ctx.from?.first_name;
  const user = await getOrCreateUser(chatId, ctx.from?.username, chatDisplayName);

  // Индикация набора текста
  await ctx.replyWithChatAction('typing');

  const parsedItems = await parseMessage(rawText, user.active_category);

  if (parsedItems.length === 0) {
    if (!isGroup) {
      await ctx.reply('Не удалось распознать пункты в сообщении. Попробуйте написать список через запятую или построчно.');
    }
    return;
  }

  const shoppingAdded = parsedItems.filter((i) => i.category === 'shopping');
  const tasksAdded = parsedItems.filter((i) => i.category === 'task');
  const primaryCategory = tasksAdded.length > shoppingAdded.length ? 'task' : 'shopping';

  // 1. Проверяем состояние текущего списка ДО добавления новых пунктов
  const existingItems = await getItems(chatId, primaryCategory);
  const hasIncompleteItems = existingItems.some((i) => !i.is_done);
  const isCurrentListFinished = existingItems.length > 0 && !hasIncompleteItems;

  // Если текущий список был полностью завершен-выполнен,
  // то для нового сообщения очищаем старые выполненные пункты и начинаем список заново!
  if (isCurrentListFinished) {
    await clearCompletedItems(chatId, primaryCategory);
    await setLastListMessageId(chatId, null);
  }

  // 2. Добавляем новые пункты в БД
  await addItems(
    chatId,
    parsedItems.map((p) => ({
      category: p.category,
      text: p.text,
    }))
  );

  // 3. Формируем краткий отчёт о том, что куда попало

  let report = '✅ <b>Добавлено:</b>\n';
  if (shoppingAdded.length > 0) {
    report += `🛒 В покупки (${shoppingAdded.length}): <i>${shoppingAdded.map((i) => i.text).join(', ')}</i>\n`;
  }
  if (tasksAdded.length > 0) {
    report += `📝 В дела (${tasksAdded.length}): <i>${tasksAdded.map((i) => i.text).join(', ')}</i>\n`;
  }

  const parserBadge = parsedItems[0]?.extractedBy === 'ai' ? ' <i>(✨ AI)</i>' : '';
  report += parserBadge;

  // 4. Если текущий список НЕ был завершен (в нем оставались невыполненные пункты),
  // пробуем ОБНОВИТЬ существующее сообщение со списком выше!
  let updatedExistingMessage = false;
  const lastMsgId = await getLastListMessageId(chatId);

  if (hasIncompleteItems && lastMsgId) {
    try {
      const [updatedItems, stats] = await Promise.all([
        getItems(chatId, primaryCategory),
        getStats(chatId),
      ]);
      const messageText = renderListMessage(primaryCategory, updatedItems, isGroup);
      const keyboard = buildListKeyboard(primaryCategory, updatedItems, stats);

      await ctx.api.editMessageText(chatId, lastMsgId, messageText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      updatedExistingMessage = true;
    } catch (e: any) {
      // Сообщение могло быть удалено пользователем или устареть (>48ч в Telegram)
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

// ---------------- CALLBACK QUERY (КНОПКИ) ---------------- //

bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat?.id;
  const messageId = ctx.callbackQuery.message?.message_id;

  if (!chatId || !messageId) {
    await ctx.answerCallbackQuery();
    return;
  }

  // Заглушка
  if (data === 'noop') {
    await ctx.answerCallbackQuery();
    return;
  }

  // Переключение табов: tab:shopping / tab:task
  if (data.startsWith('tab:')) {
    const category = data.split(':')[1] as Category;
    await setUserCategory(chatId, category);
    await ctx.answerCallbackQuery();
    await sendOrUpdateList(ctx, category, messageId);
    return;
  }

  // Переключение статуса пункта: toggle:<id>
  if (data.startsWith('toggle:')) {
    const itemId = Number(data.split(':')[1]);
    const newStatus = await toggleItemDone(chatId, itemId);
    const user = await getOrCreateUser(chatId);

    const statusText = newStatus ? 'Выполнено! ✅' : 'Возвращено в список ⬜';
    await ctx.answerCallbackQuery({ text: statusText });
    await sendOrUpdateList(ctx, user.active_category, messageId);
    return;
  }

  // Удаление выполненных: clear_done:<category>
  if (data.startsWith('clear_done:')) {
    const category = data.split(':')[1] as Category;
    const deleted = await clearCompletedItems(chatId, category);
    await ctx.answerCallbackQuery({
      text: deleted > 0 ? `Удалено выполненных: ${deleted}` : 'Нет выполненных пунктов',
    });
    await sendOrUpdateList(ctx, category, messageId);
    return;
  }

  // Запрос подтверждения закрытия списка: confirm_finish:<category>
  if (data.startsWith('confirm_finish:')) {
    const category = data.split(':')[1] as Category;
    const catName = category === 'shopping' ? 'покупок' : 'дел';
    await ctx.answerCallbackQuery();
    await ctx.api.editMessageText(
      chatId,
      messageId,
      `🏁 <b>Вы уверены, что хотите закрыть текущий список ${catName}?</b>\n\nСписок будет зафиксирован и закрыт, а следующее сообщение начнёт новый список.`,
      {
        parse_mode: 'HTML',
        reply_markup: buildConfirmFinishKeyboard(category),
      }
    );
    return;
  }

  // Подтверждение закрытия списка: do_finish:<category>
  if (data.startsWith('do_finish:')) {
    const category = data.split(':')[1] as Category;
    const stats = await getStats(chatId);
    const total = category === 'shopping' ? stats.shoppingTotal : stats.taskTotal;
    const done = category === 'shopping' ? stats.shoppingDone : stats.taskDone;

    await clearAllCategoryItems(chatId, category);
    await setLastListMessageId(chatId, null);

    await ctx.answerCallbackQuery({ text: 'Список закрыт! 🏁' });

    const title = category === 'shopping' ? '🛒 Список покупок' : '📝 Список дел';
    const closedText = `🏁 <b>${title} успешно закрыт!</b>\n\n` +
      `Всего пунктов: <b>${total}</b> (выполнено: <b>${done}</b>)\n\n` +
      `💡 <i>Отправьте новое сообщение с текстом, чтобы начать новый список!</i>`;

    const closedKeyboard = new InlineKeyboard()
      .text('➕ Начать новый список', `tab:${category}`);

    await ctx.api.editMessageText(chatId, messageId, closedText, {
      parse_mode: 'HTML',
      reply_markup: closedKeyboard,
    });
    return;
  }

  // Запрос подтверждения очистки: confirm_clear:<category>
  if (data.startsWith('confirm_clear:')) {
    const category = data.split(':')[1] as Category;
    const catName = category === 'shopping' ? 'покупок' : 'дел';
    await ctx.answerCallbackQuery();
    await ctx.api.editMessageText(
      chatId,
      messageId,
      `⚠️ <b>Вы уверены, что хотите полностью очистить весь список ${catName}?</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: buildConfirmClearKeyboard(category),
      }
    );
    return;
  }

  // Подтверждение очистки всего списка: do_clear:<category>
  if (data.startsWith('do_clear:')) {
    const category = data.split(':')[1] as Category;
    const deleted = await clearAllCategoryItems(chatId, category);
    await ctx.answerCallbackQuery({ text: `Список очищен (удалено: ${deleted})` });
    await sendOrUpdateList(ctx, category, messageId);
    return;
  }

  // Экспорт текстом: export:<category>
  if (data.startsWith('export:')) {
    const category = data.split(':')[1] as Category;
    const items = await getItems(chatId, category);
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

  // Обновление: refresh:<category>
  if (data.startsWith('refresh:')) {
    const category = data.split(':')[1] as Category;
    await ctx.answerCallbackQuery({ text: 'Обновлено 🔄' });
    await sendOrUpdateList(ctx, category, messageId);
    return;
  }

  await ctx.answerCallbackQuery();
});

// ---------------- ОБРАБОТКА ОШИБОК И ЗАПУСК ---------------- //

bot.catch((err) => {
  console.error(`Ошибка при обработке события ${err.ctx.update.update_id}:`, err.error);
});

async function main() {
  console.log('🚀 Инициализация базы данных SQLite...');
  await initDatabase();

  console.log('🤖 Запуск Telegram бота...');
  if (config.isAiEnabled) {
    console.log('✨ Gemini AI интеграция: АКТИВНА');
  } else {
    console.log('⚙️ Gemini AI: не настроен (используется быстрый локальный парсер)');
  }

  // Установка команд в меню Telegram
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
    console.warn('Не удалось зарегистрировать меню команд (проверьте правильность токена).');
  }

  bot.start({
    onStart: (botInfo) => {
      console.log(`✅ Бот @${botInfo.username} успешно запущен и готов к работе!`);
    },
  });
}

// Запускаем бота, если запущен напрямую
main().catch((err) => {
  console.error('Критическая ошибка запуска:', err);
});
