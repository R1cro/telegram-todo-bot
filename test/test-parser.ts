import { parseLocal } from '../src/parser.js';

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
];

let passed = 0;

for (const tc of testCases) {
  const result = parseLocal(tc.input, tc.defaultCat);
  const ok = result.length === tc.expectedCount;
  if (ok) {
    passed++;
    console.log(`✅ Passed: ${tc.description} (extracted ${result.length} items)`);
  } else {
    console.error(`❌ Failed: ${tc.description} (expected ${tc.expectedCount}, received ${result.length})`);
  }
  for (const item of result) {
    console.log(`   [${item.category === 'shopping' ? '🛒' : '📝'}] ${item.text}`);
  }
  console.log('');
}

console.log(`Test results: ${passed}/${testCases.length} passed.`);
if (passed !== testCases.length) {
  process.exit(1);
}
