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

  console.log('\n✅ All barcode module tests passed successfully!\n');
}

run().catch((err) => {
  console.error('❌ Barcode test failed:', err);
  process.exit(1);
});
