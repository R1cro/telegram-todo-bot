import { InlineKeyboard } from 'grammy';
import type { Category, TodoItem, CategoryStats } from './db.js';

/**
 * Formats button text, ensuring the item title expands to occupy ~3/4 of the row
 * while edit and delete buttons occupy the remaining ~1/4.
 */
function formatItemButtonText(text: string): string {
  const maxDisplayLen = 25;
  const targetPadLen = 28;

  const cleanText = text.length > maxDisplayLen
    ? text.substring(0, maxDisplayLen - 1).trim() + '…'
    : text;

  const padCount = Math.max(0, targetPadLen - cleanText.length);
  if (padCount > 0) {
    return `${cleanText}${'\u00A0'.repeat(padCount * 2)}`;
  }
  return cleanText;
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

  // 2. Interactive item rows (one row per item: [Title ~3/4] [Edit ~1/8] [Delete ~1/8])
  if (items.length > 0) {
    // Show up to 20 items per view to avoid Telegram payload limits
    const displayItems = items.slice(0, 20);

    for (const item of displayItems) {
      const qtySuffix = item.quantity && item.quantity > 1 ? ` (${item.quantity} шт.)` : '';
      const title = formatItemButtonText(`${item.text}${qtySuffix}`);

      // Button 1: Title (occupies ~3/4 of width, green success style if completed)
      if (item.is_done) {
        keyboard.add({
          text: title,
          callback_data: `toggle:${item.id}`,
          style: 'success',
        });
      } else {
        keyboard.text(title, `toggle:${item.id}`);
      }

      // Button 2: Edit button
      keyboard.text('✏️', `edit_item:${item.id}`);

      // Button 3: Delete button (red danger style)
      keyboard.add({
        text: '🗑',
        callback_data: `del_item:${item.id}`,
        style: 'danger',
      }).row();
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

/**
 * Keyboard with cancel button when user is in item text edit mode.
 */
export function buildCancelEditKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('❌ Отмена правки', 'cancel_edit');
}
