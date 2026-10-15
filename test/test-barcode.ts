import { findMatchingShoppingItem, lookupBarcodeOnline } from '../src/barcode.js';
import type { TodoItem } from '../src/db.js';

console.log('🧪 Running Barcode module test suite...\n');

async function run() {
  const mockItems: TodoItem[] = [
    {
      id: 1,
      list_id: 10,
      chat_id: 100,
      category: 'shopping',
      text: 'Молоко',
      quantity: 1,
      price: null,
      barcode: null,
      is_done: false,
      created_at: new Date().toISOString(),
    },
    {
      id: 2,
      list_id: 10,
      chat_id: 100,
      category: 'shopping',
      text: 'Сырки',
      quantity: 5,
      price: null,
      barcode: '4607000000000',
      is_done: false,
      created_at: new Date().toISOString(),
    },
    {
      id: 3,
      list_id: 10,
      chat_id: 100,
      category: 'shopping',
      text: 'Черный хлеб',
      quantity: 1,
      price: null,
      barcode: null,
      is_done: false,
      created_at: new Date().toISOString(),
    },
  ];

  // 1. Direct barcode match
  const matchByBarcode = findMatchingShoppingItem(mockItems, 'Неизвестный товар', '4607000000000');
  if (!matchByBarcode || matchByBarcode.id !== 2) {
    throw new Error('Expected match by barcode to find item id=2');
  }
  console.log('✅ Passed: Direct barcode match');

  // 2. Multi-word product name matching short list item
  const matchMilk = findMatchingShoppingItem(mockItems, 'Молоко Домик в Деревне 3.2% 930мл');
  if (!matchMilk || matchMilk.id !== 1) {
    throw new Error('Expected match by product name to find item id=1 (Молоко)');
  }
  console.log('✅ Passed: Multi-word product packaging to list item match');

  // 3. Stemming match: "Сырок творожный" matches "Сырки"
  const matchCurd = findMatchingShoppingItem(mockItems, 'Сырок глазированный ванильный');
  if (!matchCurd || matchCurd.id !== 2) {
    throw new Error('Expected stemming match "Сырок" -> "Сырки"');
  }
  console.log('✅ Passed: Russian stem matching (Сырок -> Сырки)');

  // 4. Token overlap match: "Хлеб Бородинский черный" matches "Черный хлеб"
  const matchBread = findMatchingShoppingItem(mockItems, 'Хлеб Бородинский черный нарезка');
  if (!matchBread || matchBread.id !== 3) {
    throw new Error('Expected token overlap match to find "Черный хлеб"');
  }
  console.log('✅ Passed: Token overlap matching ("Хлеб ... черный" -> "Черный хлеб")');

  // 5. Non-matching product
  const noMatch = findMatchingShoppingItem(mockItems, 'Шоколад Аленка молочный');
  if (noMatch !== null) {
    throw new Error('Expected no match for unrelated product');
  }
  console.log('✅ Passed: Unrelated product does not match any list item');

  // 6. Weight barcode detection
  const weightLookup = await lookupBarcodeOnline('2012345001505');
  if (!weightLookup || !weightLookup.name?.includes('Весовой товар')) {
    throw new Error('Expected weight barcode (prefix 20) to be identified as weight item');
  }
  console.log('✅ Passed: Internal retail weight barcode recognized');

  // GS1 Russia and Barcode-list.ru live lookup test
  try {
    const { lookupGs1Russia, lookupBarcodeListRu } = await import('../src/barcode.js');
    const gs1 = await lookupGs1Russia('4670082523924');
    if (gs1 && gs1.name) {
      console.log(`✅ Passed: GS1 Russia resolved "${gs1.name}"`);
    }
    const bcl = await lookupBarcodeListRu('4670082523924');
    if (bcl && bcl.name) {
      console.log(`✅ Passed: Barcode-list.ru resolved "${bcl.name}"`);
    }
  } catch {}

  // 7. DB integration: processScannedProduct with matching & autoAdd
  const { initDatabase, getOrCreateActiveList, addItems, getListItems, getListStats, closeActiveList } = await import('../src/db.js');
  const { processScannedProduct } = await import('../src/barcode.js');

  await initDatabase();
  const testChatId = 88888888;
  await closeActiveList(testChatId);
  const activeList = await getOrCreateActiveList(testChatId);

  // Test local starter catalog resolution
  const { getProductByBarcode } = await import('../src/db.js');
  const starterProduct = await getProductByBarcode('4600605008577');
  if (!starterProduct || !starterProduct.name.includes('Простоквашино')) {
    throw new Error('Expected starter catalog to contain Prostokvashino milk');
  }
  console.log(`✅ Passed: Local starter catalog resolved ${starterProduct.name} (${starterProduct.price} ₽)`);

  // Add initial item
  await addItems(activeList.id, testChatId, [
    { category: 'shopping', text: 'Яблоки Голден', quantity: 2 },
  ]);

  // Scan matching item with price
  const scanMatch = await processScannedProduct(testChatId, activeList.id, {
    productName: 'Яблоки Голден 1кг',
    price: 120,
    barcode: '4601112223334',
  });

  if (!scanMatch.success || scanMatch.isNewItem || !scanMatch.matchedItem) {
    throw new Error('Expected scanMatch to match existing "Яблоки Голден"');
  }
  if (scanMatch.price !== 120) {
    throw new Error('Expected scanMatch price to be 120');
  }
  console.log('✅ Passed: processScannedProduct matched existing item and applied price');

  // Scan brand new item -> should autoAdd to list and mark as bought
  const scanNew = await processScannedProduct(testChatId, activeList.id, {
    productName: 'Шоколад Ritter Sport',
    price: 189,
    barcode: '4000417025005',
  });

  if (!scanNew.success || !scanNew.isNewItem || !scanNew.createdItemId) {
    throw new Error('Expected scanNew to auto-add as new item');
  }

  const itemsAfterScan = await getListItems(activeList.id, 'shopping');
  const newItem = itemsAfterScan.find((i) => i.id === scanNew.createdItemId);
  if (!newItem || !newItem.is_done || newItem.price !== 189) {
    throw new Error('Expected auto-added item to be marked done with price 189');
  }

  const stats = await getListStats(activeList.id);
  if (stats.shoppingBoughtPrice !== 429) {
    throw new Error(`Expected total bought price to be 429 (120*2 + 189), got ${stats.shoppingBoughtPrice}`);
  }
  console.log(`✅ Passed: processScannedProduct auto-added new item, marked done, and calculated total (quantity*price): ${stats.shoppingBoughtPrice} ₽`);

  // Scan with autoAdd: false
  const scanNoAdd = await processScannedProduct(
    testChatId,
    activeList.id,
    {
      productName: 'Печенье Овсяное',
      price: 85,
      barcode: '4609998887776',
    },
    { autoAdd: false }
  );

  if (!scanNoAdd.success || !scanNoAdd.isNewItem || scanNoAdd.createdItemId) {
    throw new Error('Expected autoAdd: false to not create an item');
  }
  const itemsAfterNoAdd = await getListItems(activeList.id, 'shopping');
  if (itemsAfterNoAdd.length !== itemsAfterScan.length) {
    throw new Error('Expected item list length to remain unchanged with autoAdd: false');
  }
  console.log('✅ Passed: processScannedProduct respected autoAdd: false option');

  // Clean up
  await closeActiveList(testChatId);

  console.log('\n✅ All barcode module tests passed successfully!\n');
}

run().catch((err) => {
  console.error('❌ Barcode test failed:', err);
  process.exit(1);
});
