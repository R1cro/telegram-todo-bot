import { InlineKeyboard } from 'grammy';
import type { Category, TodoItem, CategoryStats } from './db.js';

/**
 * Formats button text, truncating if excessively long.
 */
function formatItemButtonText(text: string): string {
  const maxDisplayLen = 45;
  if (text.length > maxDisplayLen) {
    return text.substring(0, maxDisplayLen - 1).trim() + '…';
  }
  return text;
}

/**
 * Builds the inline keyboard for the active list card.
 * Each item occupies a full row (100% width) for maximum readability.
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

  // 2. Interactive item rows (one item per row = 100% full width)
  if (items.length > 0) {
    const displayItems = items.slice(0, 20);

    for (const item of displayItems) {
      const qtySuffix = item.quantity && item.quantity > 1 ? ` (${item.quantity} шт.)` : '';
      const title = formatItemButtonText(`${item.text}${qtySuffix}`);

      // Single button taking 100% full width of the row
      if (item.is_done) {
        keyboard.add({
          text: title,
          callback_data: `toggle:${item.id}`,
          style: 'success',
        }).row();
      } else {
        keyboard.text(title, `toggle:${item.id}`).row();
      }
    }

    if (items.length > 20) {
      keyboard.text(`... и ещё ${items.length - 20} позиций`, 'noop').row();
    }
  }

  // 3. Action controls
  if (items.length > 0) {
    keyboard
      .text('🏁 Закрыть список', `confirm_finish:${category}`)
      .text('📋 Текстом', `export:${category}`)
      .row();

    keyboard
      .text('✏️ Управление списком', `manage_list:${category}`)
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
 * Builds the inline keyboard for choosing an item to manage (edit or delete).
 */
export function buildManageListKeyboard(
  category: Category,
  items: TodoItem[]
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (items.length > 0) {
    const displayItems = items.slice(0, 20);
    for (const item of displayItems) {
      const qtySuffix = item.quantity && item.quantity > 1 ? ` (${item.quantity} шт.)` : '';
      const title = `⚙️ ${item.text}${qtySuffix}`;
      keyboard.text(title, `manage_item:${item.id}`).row();
    }

    if (items.length > 20) {
      keyboard.text(`... и ещё ${items.length - 20} позиций`, 'noop').row();
    }
  }

  keyboard.text('◀️ Назад к списку', `tab:${category}`);
  return keyboard;
}

/**
 * Builds the inline keyboard for managing a single item (adjust qty, edit text, delete).
 */
export function buildManageItemKeyboard(item: TodoItem): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Row 1: Quantity counter
  keyboard
    .text('➖', `qty_dec:${item.id}`)
    .text(`${item.quantity || 1} шт.`, 'noop')
    .text('➕', `qty_inc:${item.id}`)
    .row();

  // Row 2: Edit text description
  keyboard.text('✏️ Изменить текст', `edit_item:${item.id}`).row();

  // Row 3: Delete item
  keyboard.add({
    text: '🗑 Удалить позицию',
    callback_data: `del_item:${item.id}`,
    style: 'danger',
  }).row();

  // Row 4: Navigation back
  keyboard
    .text('◀️ К выбору позиции', `manage_list:${item.category}`)
    .text('📋 В список', `tab:${item.category}`);

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
