import { InlineKeyboard, Keyboard } from 'grammy';
import type { Category, TodoItem, CategoryStats } from './db.js';

/**
 * Builds the persistent bottom Reply Keyboard for quick category switching.
 * Located outside of the message block, right above the text input bar.
 */
export function buildBottomNavigationKeyboard(): Keyboard {
  return new Keyboard()
    .text('🛒 Покупки')
    .text('📝 Дела')
    .resized()
    .persistent();
}

/**
 * Formats button text, truncating if excessively long.
 */
function formatItemButtonText(text: string): string {
  const maxDisplayLen = 42;
  if (text.length > maxDisplayLen) {
    return text.substring(0, maxDisplayLen - 1).trim() + '…';
  }
  return text;
}

/**
 * Builds the inline keyboard for the active list card.
 * Each item occupies a full row (100% width) for maximum readability.
 * Items are styled with bright primary/success colors to contrast with action buttons.
 */
export function buildListKeyboard(
  category: Category,
  items: TodoItem[],
  _stats: CategoryStats
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // 1. Interactive item rows (one item per row = 100% full width)
  // Active items: style 'primary' (blue) with ▫️ icon
  // Completed items: style 'success' (green) with ✅ icon
  if (items.length > 0) {
    const displayItems = items.slice(0, 20);

    for (const item of displayItems) {
      const qtySuffix = item.quantity && item.quantity > 1 ? ` (${item.quantity} шт.)` : '';
      const title = formatItemButtonText(`${item.text}${qtySuffix}`);

      // Single button taking 100% full width of the row
      if (item.is_done) {
        keyboard.text({
          text: `✅ ${title}`,
          style: 'success',
        }, `toggle:${item.id}`).row();
      } else {
        keyboard.text({
          text: `▫️ ${title}`,
          style: 'primary',
        }, `toggle:${item.id}`).row();
      }
    }

    if (items.length > 20) {
      keyboard.text(`... и ещё ${items.length - 20} позиций`, 'noop').row();
    }
  }

  // 2. Action controls (neutral default styling to clearly separate from items)
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
    keyboard.text({
      text: '🗑 Очистить всё',
      style: 'danger',
    }, `confirm_clear:${category}`);
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
      keyboard.text({
        text: title,
        style: 'primary',
      }, `manage_item:${item.id}`).row();
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

  // Row 3: Delete item with danger styling
  keyboard.text({
    text: '🗑 Удалить позицию',
    style: 'danger',
  }, `del_item:${item.id}`).row();

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
    .text({ text: '⚠️ Да, очистить', style: 'danger' }, `do_clear:${category}`)
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
