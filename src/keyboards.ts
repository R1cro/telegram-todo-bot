import { InlineKeyboard } from 'grammy';
import type { Category, TodoItem, CategoryStats } from './db.js';

/**
 * Создает инлайн-клавиатуру для активного списка
 */
export function buildListKeyboard(
  category: Category,
  items: TodoItem[],
  stats: CategoryStats
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // 1. Строка переключения категорий (Табы)
  const shoppingDone = stats.shoppingDone;
  const shoppingTotal = stats.shoppingTotal;
  const taskDone = stats.taskDone;
  const taskTotal = stats.taskTotal;

  const shoppingLabel = category === 'shopping'
    ? `👉 🛒 Покупки (${shoppingDone}/${shoppingTotal})`
    : `🛒 Покупки (${shoppingTotal})`;

  const taskLabel = category === 'task'
    ? `👉 📝 Дела (${taskDone}/${taskTotal})`
    : `📝 Дела (${taskTotal})`;

  keyboard
    .text(shoppingLabel, 'tab:shopping')
    .text(taskLabel, 'tab:task')
    .row();

  // 2. Список пунктов (каждый пункт - кликабельная кнопка для переключения статуса)
  if (items.length > 0) {
    // Ограничиваем до 20 элементов на экран для компактности Telegram клавиатуры
    const displayItems = items.slice(0, 20);

    for (const item of displayItems) {
      const icon = item.is_done ? '✅' : '⬜';
      // Ограничиваем длину текста на кнопке Telegram (макс ~35 символов)
      const truncatedText = item.text.length > 35
        ? item.text.substring(0, 32) + '...'
        : item.text;

      const buttonText = `${icon} ${truncatedText}`;
      keyboard.text(buttonText, `toggle:${item.id}`).row();
    }

    if (items.length > 20) {
      keyboard.text(`... и еще ${items.length - 20} пунктов`, 'noop').row();
    }
  }

  // 3. Панель действий
  if (items.length > 0) {
    keyboard
      .text('🏁 Закрыть список', `confirm_finish:${category}`)
      .text('📋 Текстом', `export:${category}`)
      .row();
  }

  const hasDoneItems = items.some((i) => i.is_done);
  if (hasDoneItems) {
    keyboard.text('🧹 Удалить выполненные', `clear_done:${category}`);
  }
  if (items.length > 0) {
    keyboard.text('🗑 Очистить всё', `confirm_clear:${category}`);
  }
  if (hasDoneItems || items.length > 0) {
    keyboard.row();
  }

  keyboard.text('🔄 Обновить', `refresh:${category}`);

  return keyboard;
}

/**
 * Клавиатура подтверждения очистки списка
 */
export function buildConfirmClearKeyboard(category: Category): InlineKeyboard {
  return new InlineKeyboard()
    .text('⚠️ Да, очистить', `do_clear:${category}`)
    .text('❌ Отмена', `tab:${category}`);
}

/**
 * Клавиатура подтверждения закрытия списка
 */
export function buildConfirmFinishKeyboard(category: Category): InlineKeyboard {
  return new InlineKeyboard()
    .text('🏁 Да, закрыть список', `do_finish:${category}`)
    .text('❌ Отмена', `tab:${category}`);
}
