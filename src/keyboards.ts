import { InlineKeyboard } from 'grammy';
import type { Category, TodoItem, CategoryStats } from './db.js';

/**
 * Formats button text with trailing non-breaking spaces and an invisible Braille pattern blank
 * so Telegram clients position the checkbox icon and item text aligned to the left.
 */
function formatItemButtonText(icon: string, text: string): string {
  const maxDisplayLen = 27;
  const targetPadLen = 30;

  const cleanText = text.length > maxDisplayLen
    ? text.substring(0, maxDisplayLen - 1).trim() + '…'
    : text;

  const currentLen = cleanText.length + 2; // icon + space
  const padCount = Math.max(0, Math.round((targetPadLen - currentLen) * 1.3));

  if (padCount > 0) {
    return `${icon} ${cleanText}${'\u00A0'.repeat(padCount)}\u2800`;
  }
  return `${icon} ${cleanText}`;
}

/**
 * Builds the inline keyboard for the active list card.
 */
export function buildListKeyboard(
  category: Category,
  items: TodoItem[],
  stats: CategoryStats
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // 1. Category tabs row
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

  // 2. Interactive item buttons (clickable to toggle check/uncheck status)
  if (items.length > 0) {
    // Show up to 20 items per view to avoid Telegram payload limits
    const displayItems = items.slice(0, 20);

    for (const item of displayItems) {
      const icon = item.is_done ? '✅' : '⬜';
      const buttonText = formatItemButtonText(icon, item.text);
      keyboard.text(buttonText, `toggle:${item.id}`).row();
    }

    if (items.length > 20) {
      keyboard.text(`... and ${items.length - 20} more items`, 'noop').row();
    }
  }

  // 3. Action controls
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
 * Confirmation dialog keyboard for clearing category items.
 */
export function buildConfirmClearKeyboard(category: Category): InlineKeyboard {
  return new InlineKeyboard()
    .text('⚠️ Да, очистить', `do_clear:${category}`)
    .text('❌ Отмена', `tab:${category}`);
}

/**
 * Confirmation dialog keyboard for closing the active list entity.
 */
export function buildConfirmFinishKeyboard(category: Category): InlineKeyboard {
  return new InlineKeyboard()
    .text('🏁 Да, закрыть список', `do_finish:${category}`)
    .text('❌ Отмена', `tab:${category}`);
}
