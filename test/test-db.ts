import {
  initDatabase,
  getOrCreateUser,
  setUserCategory,
  getActiveList,
  getOrCreateActiveList,
  closeActiveList,
  setListLastMessageId,
  addItems,
  getListItems,
  toggleItemDone,
  clearCompletedFromList,
  clearCategoryFromList,
  getListStats,
  getItemById,
  updateItemQuantity,
  updateItemText,
} from '../src/db.js';

console.log('🧪 Running SQLite database entity lifecycle test suite...\n');

async function run() {
  await initDatabase();
  console.log('✅ Database schema initialized successfully');

  const testChatId = 77777777;

  // 1. User creation and category configuration
  const user = await getOrCreateUser(testChatId, 'tester', 'Test User');
  console.log(`✅ User verified: chat_id=${user.chat_id}, active_category=${user.active_category}`);

  await setUserCategory(testChatId, 'task');
  const updatedUser = await getOrCreateUser(testChatId);
  if (updatedUser.active_category !== 'task') {
    throw new Error('User category update failed');
  }
  console.log(`✅ Category updated: active_category=${updatedUser.active_category}`);

  // 2. Active TodoList entity creation
  const initialActive = await getActiveList(testChatId);
  if (initialActive) {
    await closeActiveList(testChatId);
  }

  const list1 = await getOrCreateActiveList(testChatId);
  console.log(`✅ Active list created: id=${list1.id}, status=${list1.status}`);
  if (list1.status !== 'active') {
    throw new Error('Expected initial list status to be active');
  }

  // Verify getActiveList returns the same entity
  const fetchedActive = await getActiveList(testChatId);
  if (!fetchedActive || fetchedActive.id !== list1.id) {
    throw new Error('getActiveList did not return the matching active list');
  }

  // 3. Appending items to active list entity
  const addedIds = await addItems(list1.id, testChatId, [
    { category: 'shopping', text: 'Apples' },
    { category: 'shopping', text: 'Bread' },
    { category: 'task', text: 'Pay utility bills' },
  ]);
  console.log(`✅ Appended ${addedIds.length} items to active list ${list1.id}`);

  // 4. Retrieving items scoped to the active list
  const shoppingItems = await getListItems(list1.id, 'shopping');
  const taskItems = await getListItems(list1.id, 'task');
  console.log(`✅ Retrieved items: shopping=${shoppingItems.length}, tasks=${taskItems.length}`);
  if (shoppingItems.length !== 2 || taskItems.length !== 1) {
    throw new Error('Unexpected item counts returned from getListItems');
  }

  // 5. Toggling completion status
  const firstShopping = shoppingItems[0];
  const toggled = await toggleItemDone(testChatId, firstShopping.id);
  console.log(`✅ Toggled item ${firstShopping.id}: is_done=${toggled}`);
  if (!toggled) {
    throw new Error('Expected item to be toggled to completed');
  }

  // 6. Checking stats for active list
  const stats = await getListStats(list1.id);
  console.log(`✅ List stats: Shopping (${stats.shoppingDone}/${stats.shoppingTotal}), Tasks (${stats.taskDone}/${stats.taskTotal})`);
  if (stats.shoppingTotal !== 2 || stats.shoppingDone !== 1 || stats.taskTotal !== 1) {
    throw new Error('Unexpected statistics calculated');
  }

  // 7. Tracking Telegram message ID for active list
  await setListLastMessageId(list1.id, 54321);
  const reloadedList = await getActiveList(testChatId);
  if (reloadedList?.last_message_id !== 54321) {
    throw new Error('Failed to update and persist last_message_id');
  }
  console.log(`✅ Persisted message ID ${reloadedList.last_message_id} on list ${list1.id}`);

  // 8. Clearing completed items from active list
  const removedCompleted = await clearCompletedFromList(list1.id, 'shopping');
  console.log(`✅ Cleared completed items: removed=${removedCompleted}`);
  const remainingShopping = await getListItems(list1.id, 'shopping');
  if (remainingShopping.length !== 1) {
    throw new Error('Expected 1 active shopping item remaining');
  }

  // 9. Closing active list entity
  const closed = await closeActiveList(testChatId);
  console.log(`✅ Closed active list: id=${closed?.id}, status=${closed?.status}`);
  if (closed?.status !== 'closed') {
    throw new Error('Expected closed list status');
  }

  const noActive = await getActiveList(testChatId);
  if (noActive !== null) {
    throw new Error('Expected no active list after closing');
  }
  console.log('✅ Verified no active list remains open after closing');

  // 10. Verification of new list creation cycle after closing
  const list2 = await getOrCreateActiveList(testChatId);
  console.log(`✅ New active list created after close: id=${list2.id}`);
  if (list2.id === list1.id) {
    throw new Error('Expected a fresh list id after closing previous list');
  }

  const freshShopping = await getListItems(list2.id, 'shopping');
  if (freshShopping.length !== 0) {
    throw new Error('Expected new list entity to start empty');
  }
  console.log('✅ Verified fresh list starts completely empty');

  // 11. Verification of item quantity counter and text editing
  const [createdItemId] = await addItems(list2.id, testChatId, [
    { category: 'shopping', text: 'Sample Item', quantity: 10 },
  ]);
  const retrievedItem = await getItemById(testChatId, createdItemId);
  if (!retrievedItem || retrievedItem.quantity !== 10) {
    throw new Error('Expected initial quantity to be 10');
  }
  console.log(`✅ Item quantity verified: id=${createdItemId}, quantity=${retrievedItem.quantity}`);

  const incQty = await updateItemQuantity(testChatId, createdItemId, 1);
  if (incQty !== 11) throw new Error('Expected quantity increment to 11');
  console.log(`✅ Item quantity incremented: quantity=${incQty}`);

  const decQty = await updateItemQuantity(testChatId, createdItemId, -2);
  if (decQty !== 9) throw new Error('Expected quantity decrement to 9');
  console.log(`✅ Item quantity decremented: quantity=${decQty}`);

  const textUpdated = await updateItemText(testChatId, createdItemId, 'Updated Sample Item');
  if (!textUpdated) throw new Error('Expected text update to succeed');
  const updatedItem = await getItemById(testChatId, createdItemId);
  if (updatedItem?.text !== 'Updated Sample Item') {
    throw new Error('Item text does not match updated value');
  }
  console.log(`✅ Item text updated successfully: "${updatedItem.text}"`);

  // Cleanup test artifacts
  await clearCategoryFromList(list2.id, 'shopping');
  await clearCategoryFromList(list2.id, 'task');
  await closeActiveList(testChatId);

  console.log('✅ All database entity lifecycle tests passed successfully!\n');
}

run().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
