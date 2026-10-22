import { InlineKeyboard } from 'grammy';
import type { Category, TodoItem, CategoryStats, PeriodFilter, Receipt } from './db.js';
import type { ExpensesTab } from './analytics.js';

/**
 * Builds the inline keyboard for the separate navigation message located under the list card.
 */
export function buildNavigationKeyboard(
  category: Category,
  stats: CategoryStats
): InlineKeyboard {
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

  const keyboard = new InlineKeyboard();

  if (category === 'shopping') {
    keyboard.text({ text: shoppingLabel, style: 'primary' }, 'tab:shopping');
    keyboard.text(taskLabel, 'tab:task');
  } else {
    keyboard.text(shoppingLabel, 'tab:shopping');
    keyboard.text({ text: taskLabel, style: 'primary' }, 'tab:task');
  }

  return keyboard;
}

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
 * Items are styled with bright primary/success colors to contrast with action buttons.
 */
export function buildListKeyboard(
  category: Category,
  items: TodoItem[],
  _stats: CategoryStats
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // 1. Interactive item rows (one item per row = 100% full width)
  // Active items: style 'primary' (blue), no checkbox icon
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
          text: title,
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
      .text('📊 Траты', 'exp_open:7d')
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

/**
 * Builds the interactive keyboard for the expenses analytics dashboard.
 * Supports switching periods (7d, 14d, 30d) and tabs (overview, categories, products, users, receipts).
 */
export function buildExpensesKeyboard(
  activePeriod: PeriodFilter = '7d',
  activeTab: ExpensesTab = 'overview',
  isGroup: boolean = false,
  recentReceiptIds: number[] = []
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Row 1: Period filters
  const period7Text = activePeriod === '7d' ? '👉 7 дней' : '7 дней';
  const period14Text = activePeriod === '14d' ? '👉 14 дней' : '14 дней';
  const period30Text = activePeriod === '30d' ? '👉 Месяц' : 'Месяц';

  if (activePeriod === '7d') {
    keyboard.text({ text: period7Text, style: 'primary' }, `exp_period:7d:${activeTab}`);
  } else {
    keyboard.text(period7Text, `exp_period:7d:${activeTab}`);
  }

  if (activePeriod === '14d') {
    keyboard.text({ text: period14Text, style: 'primary' }, `exp_period:14d:${activeTab}`);
  } else {
    keyboard.text(period14Text, `exp_period:14d:${activeTab}`);
  }

  if (activePeriod === '30d') {
    keyboard.text({ text: period30Text, style: 'primary' }, `exp_period:30d:${activeTab}`);
  } else {
    keyboard.text(period30Text, `exp_period:30d:${activeTab}`);
  }
  keyboard.row();

  // Row 2: Analytics tabs
  const tabOverview = activeTab === 'overview' ? '👉 📊 Обзор' : '📊 Обзор';
  const tabCats = activeTab === 'categories' ? '👉 🏷 Категории' : '🏷 Категории';
  const tabProducts = activeTab === 'products' ? '👉 🏆 Товары' : '🏆 Товары';

  if (activeTab === 'overview') {
    keyboard.text({ text: tabOverview, style: 'primary' }, `exp_tab:${activePeriod}:overview`);
  } else {
    keyboard.text(tabOverview, `exp_tab:${activePeriod}:overview`);
  }

  if (activeTab === 'categories') {
    keyboard.text({ text: tabCats, style: 'primary' }, `exp_tab:${activePeriod}:categories`);
  } else {
    keyboard.text(tabCats, `exp_tab:${activePeriod}:categories`);
  }

  if (activeTab === 'products') {
    keyboard.text({ text: tabProducts, style: 'primary' }, `exp_tab:${activePeriod}:products`);
  } else {
    keyboard.text(tabProducts, `exp_tab:${activePeriod}:products`);
  }
  keyboard.row();

  // Row 3: Users (for groups) & Receipts
  if (isGroup) {
    const tabUsers = activeTab === 'users' ? '👉 👥 Участники' : '👥 Участники';
    if (activeTab === 'users') {
      keyboard.text({ text: tabUsers, style: 'primary' }, `exp_tab:${activePeriod}:users`);
    } else {
      keyboard.text(tabUsers, `exp_tab:${activePeriod}:users`);
    }
  }

  const tabReceipts = activeTab === 'receipts' ? '👉 🧾 Чеки' : '🧾 Чеки';
  if (activeTab === 'receipts') {
    keyboard.text({ text: tabReceipts, style: 'primary' }, `exp_tab:${activePeriod}:receipts`);
  } else {
    keyboard.text(tabReceipts, `exp_tab:${activePeriod}:receipts`);
  }
  keyboard.row();

  // If in receipts tab and receipts exist, show view details and delete buttons
  if (activeTab === 'receipts' && recentReceiptIds.length > 0) {
    for (const id of recentReceiptIds) {
      keyboard
        .text(`👁 Чек #${id}`, `view_receipt:${id}:${activePeriod}`)
        .text({ text: `🗑 Удалить #${id}`, style: 'danger' }, `exp_del_receipt:${id}:${activePeriod}`)
        .row();
    }
  }

  // Row 4: Refresh and back to shopping list
  keyboard
    .text('🔄 Обновить', `exp_refresh:${activePeriod}:${activeTab}`)
    .text('🛒 К списку', 'tab:shopping');

  return keyboard;
}

/**
 * Builds the inline keyboard for a newly scanned receipt card.
 */
export function buildReceiptCardKeyboard(receiptId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('📊 Дэшборд трат', 'exp_open:7d')
    .text('🧾 Все чеки', 'view_all_receipts')
    .text('🛒 К списку', 'tab:shopping')
    .row()
    .text({ text: '🗑 Удалить этот чек', style: 'danger' }, `exp_del_receipt:${receiptId}:7d`);
}

/**
 * Builds inline keyboard for the /receipts list command.
 */
export function buildReceiptsListKeyboard(receipts: Receipt[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (let i = 0; i < receipts.length; i += 2) {
    const r1 = receipts[i];
    const r2 = receipts[i + 1];

    keyboard.text(`👁 Чек #${r1.id}`, `view_receipt:${r1.id}`);
    if (r2) {
      keyboard.text(`👁 Чек #${r2.id}`, `view_receipt:${r2.id}`);
    }
    keyboard.row();
  }

  keyboard
    .text('📊 Дэшборд трат', 'exp_open:7d')
    .text('🛒 К списку', 'tab:shopping');

  return keyboard;
}

/**
 * Builds inline keyboard when inspecting a single receipt in detail.
 */
export function buildReceiptDetailKeyboard(receiptId: number, backPeriod: PeriodFilter = '7d'): InlineKeyboard {
  return new InlineKeyboard()
    .text('◀️ Назад к чекам', `exp_tab:${backPeriod}:receipts`)
    .text('📊 Дэшборд', `exp_open:${backPeriod}`)
    .row()
    .text({ text: '🗑 Удалить этот чек', style: 'danger' }, `exp_del_receipt:${receiptId}:${backPeriod}`)
    .text('🛒 К списку', 'tab:shopping');
}
