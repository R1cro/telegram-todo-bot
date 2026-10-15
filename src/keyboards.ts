import { InlineKeyboard } from 'grammy';
import type { Category, TodoItem, CategoryStats } from './db.js';

/**
 * Formats button text, truncating if too long for the inline keyboard row.
 */
function formatItemButtonText(text: string, isFullWidth = false): string {
  const maxDisplayLen = isFullWidth ? 35 : 18;
  const cleanText = text.length > maxDisplayLen
    ? text.substring(0, maxDisplayLen - 1).trim() + '…'
    : text;
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

  // 2. Interactive item buttons (clickable to toggle status and adjust quantity)
  if (items.length > 0) {
    // Show up to 20 items per view to avoid Telegram payload limits
    const displayItems = items.slice(0, 20);

    for (const item of displayItems) {
      if (item.is_done) {
        // Completed items: full-width button with green success style and no checkbox icon
        const doneLabel = item.quantity && item.quantity > 1 ? `${item.text} (${item.quantity} шт.)` : item.text;
        const buttonText = formatItemButtonText(doneLabel, true);
        keyboard.add({
          text: buttonText,
          callback_data: `toggle:${item.id}`,
          style: 'success',
        }).row();
      } else {
        // Active items: clean title button without duplicated quantity, and -, count, + controls in ONE row
        const qty = item.quantity || 1;
        const buttonText = formatItemButtonText(item.text, false);
        keyboard
          .text(buttonText, `toggle:${item.id}`)
          .text('➖', `qty_dec:${item.id}`)
          .text(`${qty} шт.`, 'noop')
          .text('➕', `qty_inc:${item.id}`)
          .row();
      }
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
      .text('✏️ Правка', `prompt_edit:${category}`)
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
