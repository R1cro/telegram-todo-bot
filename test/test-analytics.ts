import {
  initDatabase,
  getOrCreateActiveList,
  addItems,
  getListItems,
  addReceipt,
  getReceiptById,
  deleteReceipt,
  getRecentReceipts,
  getExpensesSummary,
  getCategoryExpenses,
  getUserExpenses,
  getProductPopularity,
  markMatchingShoppingItemsDone,
} from '../src/db.js';

async function runAnalyticsTests() {
  console.log('🧪 Running receipt analytics & database test suite...\n');

  await initDatabase();
  console.log('✅ Database schema initialized successfully');

  const testChatId = 88889999;
  const testUserId1 = 1001;
  const testUserId2 = 1002;

  // Clean up any previous test artifacts
  const existingReceipts = await getRecentReceipts(testChatId, 50);
  for (const r of existingReceipts) {
    await deleteReceipt(testChatId, r.id);
  }

  // 1. Add active shopping list with items
  const activeList = await getOrCreateActiveList(testChatId);
  await addItems(activeList.id, testChatId, [
    { category: 'shopping', text: 'Молоко 3.2%', quantity: 2 },
    { category: 'shopping', text: 'Хлеб тостовый', quantity: 1 },
    { category: 'shopping', text: 'Яйца десяток', quantity: 1 },
    { category: 'task', text: 'Позвонить в банк', quantity: 1 },
  ]);

  const initialItems = await getListItems(activeList.id, 'shopping');
  console.log(`✅ Active shopping list prepared with ${initialItems.length} items`);

  // 2. Add receipt #1 (User 1001: Пятёрочка)
  const nowIso = new Date().toISOString();
  const receipt1 = await addReceipt(
    testChatId,
    testUserId1,
    'Alice',
    'Пятёрочка',
    nowIso,
    1450.50,
    [
      { name: 'Молоко Домик в деревне 3.2%', category: 'Молочные продукты', quantity: 2, unit_price: 90, total_price: 180 },
      { name: 'Хлеб тостовый белый', category: 'Хлеб и выпечка', quantity: 1, unit_price: 65, total_price: 65 },
      { name: 'Сыр Российский 300г', category: 'Бакалея и сыры', quantity: 1, unit_price: 320, total_price: 320 },
      { name: 'Филе индейки 1кг', category: 'Мясо, птица, рыба', quantity: 1, unit_price: 550, total_price: 550 },
      { name: 'Яблоки сезонные 1кг', category: 'Овощи и фрукты', quantity: 1.5, unit_price: 130, total_price: 195 },
      { name: 'Шоколад Аленка', category: 'Сладости и снеки', quantity: 2, unit_price: 70.25, total_price: 140.50 },
    ],
    JSON.stringify({ raw: 'mock_receipt_1' })
  );

  console.log(`✅ Receipt #1 inserted: id=${receipt1.id}, store=${receipt1.store_name}, total=${receipt1.total_amount}`);

  // 3. Add receipt #2 (User 1002: ВкусВилл)
  const receipt2 = await addReceipt(
    testChatId,
    testUserId2,
    'Bob',
    'ВкусВилл',
    nowIso,
    850.00,
    [
      { name: 'Молоко цельное', category: 'Молочные продукты', quantity: 1, unit_price: 95, total_price: 95 },
      { name: 'Мандарины 1кг', category: 'Овощи и фрукты', quantity: 1, unit_price: 250, total_price: 250 },
      { name: 'Круассан с миндалем', category: 'Хлеб и выпечка', quantity: 2, unit_price: 160, total_price: 320 },
      { name: 'Морс клюквенный 0.5л', category: 'Напитки', quantity: 1, unit_price: 185, total_price: 185 },
    ]
  );

  console.log(`✅ Receipt #2 inserted: id=${receipt2.id}, store=${receipt2.store_name}, total=${receipt2.total_amount}`);

  // 4. Test getReceiptById
  const fetched = await getReceiptById(receipt1.id);
  if (!fetched || fetched.items?.length !== 6) {
    throw new Error('Failed to fetch receipt with items');
  }
  console.log(`✅ getReceiptById verified: items count=${fetched.items.length}`);

  // 5. Test markMatchingShoppingItemsDone
  const boughtNames = receipt1.items!.map((i) => i.name);
  const matched = await markMatchingShoppingItemsDone(testChatId, activeList.id, boughtNames);
  console.log(`✅ Auto-matched ${matched.length} items from receipt: ${matched.map((m) => m.text).join(', ')}`);
  if (matched.length < 2) {
    throw new Error('Expected at least 2 items (Молоко, Хлеб) to be matched');
  }

  // 6. Test Expenses Summary (7 days)
  const summary7 = await getExpensesSummary(testChatId, 7);
  console.log(`✅ Summary (7 days): total=${summary7.totalAmount} ₽, receipts=${summary7.receiptsCount}, items=${summary7.itemsCount}, avg=${summary7.averageReceipt} ₽`);
  if (summary7.receiptsCount !== 2 || Math.abs(summary7.totalAmount - 2300.50) > 0.1) {
    throw new Error(`Unexpected summary7: ${JSON.stringify(summary7)}`);
  }

  // 7. Test Category Breakdown
  const categories = await getCategoryExpenses(testChatId, 30);
  console.log(`✅ Categories breakdown (${categories.length} categories found):`);
  for (const cat of categories) {
    console.log(`   • ${cat.category}: ${cat.totalSpent} ₽ (${cat.percentage}%, items: ${cat.itemsCount})`);
  }
  if (categories.length === 0) throw new Error('Categories list is empty');

  // 8. Test User Expenses (Group members breakdown)
  const userShares = await getUserExpenses(testChatId, 30);
  console.log(`✅ Group members breakdown (${userShares.length} users):`);
  for (const u of userShares) {
    console.log(`   • ${u.user_name}: ${u.totalSpent} ₽ (${u.percentage}%, receipts: ${u.receiptsCount})`);
  }
  if (userShares.length !== 2) throw new Error('Expected 2 users in breakdown');

  // 9. Test Product Popularity Table
  const popularity = await getProductPopularity(testChatId, 30, 5);
  console.log(`✅ Top popular/expensive products:`);
  for (const p of popularity) {
    console.log(`   • ${p.name} [${p.category}]: spent ${p.totalSpent} ₽ (qty: ${p.totalQuantity}, bought ${p.buyCount} times)`);
  }
  if (popularity.length === 0) throw new Error('Product popularity list is empty');

  // 10. Test Delete Receipt
  const deleted = await deleteReceipt(testChatId, receipt2.id);
  console.log(`✅ deleteReceipt executed: success=${deleted}`);
  const postDeleteSummary = await getExpensesSummary(testChatId, 7);
  if (postDeleteSummary.receiptsCount !== 1) {
    throw new Error('Expected 1 receipt left after deletion');
  }

  // 11. Test formatCategoryBadge and renderReceiptCard formatting
  const { formatCategoryBadge, renderReceiptCard } = await import('../src/analytics.js');
  const badgeSweets = formatCategoryBadge('Сладости и снеки');
  const badgeProduce = formatCategoryBadge('Овощи и фрукты');
  const badgeDairy = formatCategoryBadge('Молочные продукты');
  const badgeBakery = formatCategoryBadge('Хлеб и выпечка');
  const badgeMeat = formatCategoryBadge('Мясо, птица, рыба');

  if (badgeSweets !== '🟠 [Сладости и снеки]') throw new Error(`Unexpected badgeSweets: ${badgeSweets}`);
  if (badgeProduce !== '🟢 [Овощи и фрукты]') throw new Error(`Unexpected badgeProduce: ${badgeProduce}`);
  if (badgeDairy !== '🟣 [Молочные продукты]') throw new Error(`Unexpected badgeDairy: ${badgeDairy}`);
  if (badgeBakery !== '🟡 [Хлеб и выпечка]') throw new Error(`Unexpected badgeBakery: ${badgeBakery}`);
  if (badgeMeat !== '🔴 [Мясо, птица, рыба]') throw new Error(`Unexpected badgeMeat: ${badgeMeat}`);

  const renderedCard = renderReceiptCard(receipt1);
  if (renderedCard.includes('<code>')) {
    throw new Error(`Receipt card contains unexpected <code> tag (which causes tap-to-copy button):\n${renderedCard}`);
  }
  console.log(`✅ Verified category badges and confirmed NO <code> tags in receipt card:\n   ${badgeSweets}, ${badgeProduce}, ${badgeDairy}`);

  console.log('\n🎉 All receipt analytics & database tests passed successfully!');
}

runAnalyticsTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
