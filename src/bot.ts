import { Bot, Context } from 'grammy';
import { config, validateConfig } from './config.js';
import {
  initDatabase,
  getOrCreateUser,
  setUserCategory,
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
import { buildListKeyboard, buildConfirmClearKeyboard } from './keyboards.js';

validateConfig();

export const bot = new Bot(config.botToken);

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
      return;
    } catch (e: any) {
      // Игнорируем ошибку Telegram "message is not modified"
      if (!String(e?.message).includes('message is not modified')) {
        console.error('Ошибка редактирования сообщения:', e);
      }
    }
  }

  await ctx.reply(messageText, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
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

  // В группе отсекаем обычные разговоры ("привет", "ок", "я скоро буду"),
  // если это не явный список и не обращение к боту
  if (isGroup && !isMentioned && !isReplyToBot) {
    const hasListPrefix = /^(покупки|купить|шопинг|дела|задачи|сделать|список)\s*[:\-]/iu.test(rawText);
    const hasMultipleLines = rawText.includes('\n');
    const hasBulletsOrNumbers = /^(\s*[-*•—+>]|\d+[\.\)])/m.test(rawText);
    const hasKeywords = /(купить|взять|надо|нужно|сделать|напомни|пакет|хлеб|молоко|сыр|мясо|яйца|овощи|фрукты)/iu.test(rawText);
    const hasCommaList = rawText.includes(',') && rawText.split(',').length >= 2 && hasKeywords;

    const isIntentionalList = hasListPrefix || (hasMultipleLines && hasBulletsOrNumbers) || hasCommaList || hasKeywords;

    if (!isIntentionalList) {
      return; // Игнорируем обычный чат в группе
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

  // Добавляем в БД
  await addItems(
    chatId,
    parsedItems.map((p) => ({
      category: p.category,
      text: p.text,
    }))
  );

  // Формируем краткий отчёт о том, что куда попало
  const shoppingAdded = parsedItems.filter((i) => i.category === 'shopping');
  const tasksAdded = parsedItems.filter((i) => i.category === 'task');

  let report = '✅ <b>Добавлено:</b>\n';
  if (shoppingAdded.length > 0) {
    report += `🛒 В покупки (${shoppingAdded.length}): <i>${shoppingAdded.map((i) => i.text).join(', ')}</i>\n`;
  }
  if (tasksAdded.length > 0) {
    report += `📝 В дела (${tasksAdded.length}): <i>${tasksAdded.map((i) => i.text).join(', ')}</i>\n`;
  }

  const parserBadge = parsedItems[0]?.extractedBy === 'ai' ? ' <i>(✨ AI)</i>' : '';
  report += parserBadge;

  await ctx.reply(report, { parse_mode: 'HTML' });

  // Показываем актуальный список той категории, куда было добавлено больше всего пунктов
  const primaryCategory = tasksAdded.length > shoppingAdded.length ? 'task' : 'shopping';
  await sendOrUpdateList(ctx, primaryCategory);
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
