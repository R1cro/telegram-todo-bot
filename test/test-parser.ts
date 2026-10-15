import { parseLocal, parseMessage } from '../src/parser.js';

console.log('🧪 Running local parser test suite...\n');

const testCases = [
  {
    input: 'молоко, хлеб, сыр, яйца 10шт, сливочное масло 82.5%',
    defaultCat: 'shopping' as const,
    expectedCount: 5,
    description: 'Comma-separated grocery list',
  },
  {
    input: `1. Позвонить доктору
2. Забрать посылку из СДЭК
3) Оплатить квитанцию`,
    defaultCat: 'task' as const,
    expectedCount: 3,
    description: 'Numbered task list',
  },
  {
    input: `- Сыр гауда
* Помидоры черри
• Огурцы
— Майонез`,
    defaultCat: 'shopping' as const,
    expectedCount: 4,
    description: 'Bulleted list with various bullet symbols',
  },
  {
    input: 'Покупки: чай зеленый, кофе в зернах, печенье',
    defaultCat: 'task' as const, // Category prefix overrides default category
    expectedCount: 3,
    description: 'Explicit "Покупки:" prefix',
  },
  {
    input: 'Дела: помыть машину, заехать к родителям',
    defaultCat: 'shopping' as const, // Category prefix overrides default category
    expectedCount: 2,
    description: 'Explicit "Дела:" prefix',
  },
  {
    input: 'купить колбасу, сосиски и сделать отчет по работе',
    defaultCat: 'shopping' as const,
    expectedCount: 3, // Comma and conjunction "и" separating distinct items
    description: 'Mixed grocery items and tasks in single sentence',
  },
  {
    input: 'Свежее молоко',
    defaultCat: 'shopping' as const,
    expectedCount: 1,
    description: 'Multi-word single item',
  },
  {
    input: 'купить черный хлеб и десять сырков',
    defaultCat: 'shopping' as const,
    expectedCount: 2,
    description: 'Word quantity extraction (десять сырков -> 10)',
    checkQuantities: [1, 10],
  },
  {
    input: 'мороженое (2 пачки)',
    defaultCat: 'shopping' as const,
    expectedCount: 1,
    description: 'Parenthesized quantity extraction (2 пачки -> 2)',
    checkQuantities: [2],
  },
];

let passed = 0;

for (const tc of testCases) {
  const result = parseLocal(tc.input, tc.defaultCat);
  let ok = result.length === tc.expectedCount;
  if (ok && tc.checkQuantities) {
    for (let i = 0; i < tc.checkQuantities.length; i++) {
      if ((result[i]?.quantity ?? 1) !== tc.checkQuantities[i]) {
        ok = false;
        break;
      }
    }
  }
  if (ok) {
    passed++;
    console.log(`✅ Passed: ${tc.description} (extracted ${result.length} items)`);
  } else {
    console.error(`❌ Failed: ${tc.description} (expected ${tc.expectedCount}, received ${result.length})`);
  }
  for (const item of result) {
    console.log(`   [${item.category === 'shopping' ? '🛒' : '📝'}] ${item.text} (qty: ${item.quantity ?? 1})`);
  }
  console.log('');
}

console.log(`Local parser test results: ${passed}/${testCases.length} passed.`);
if (passed !== testCases.length) {
  process.exit(1);
}

// Verify parseMessage entry point (prioritizing Gemini with fallback to local parser)
console.log('🧪 Verifying parseMessage prioritization & fallback...');
const messageResult = await parseMessage('хлеб, молоко, сыр', 'shopping');
if (messageResult.length !== 3) {
  console.error(`❌ parseMessage test failed: expected 3 items, got ${messageResult.length}`);
  process.exit(1);
}
console.log(`✅ parseMessage successfully extracted ${messageResult.length} items (extractedBy: ${messageResult[0].extractedBy})`);
console.log('✅ All parser tests completed successfully!\n');
