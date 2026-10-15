import { parseLocal } from '../src/parser.js';

console.log('🧪 Тестирование локального парсера...\n');

const testCases = [
  {
    input: 'молоко, хлеб, сыр, яйца 10шт, сливочное масло 82.5%',
    defaultCat: 'shopping' as const,
    expectedCount: 5,
    description: 'Список покупок через запятую',
  },
  {
    input: `1. Позвонить доктору
2. Забрать посылку из СДЭК
3) Оплатить квитанцию`,
    defaultCat: 'task' as const,
    expectedCount: 3,
    description: 'Нумерованный список задач',
  },
  {
    input: `- Сыр гауда
* Помидоры черри
• Огурцы
— Майонез`,
    defaultCat: 'shopping' as const,
    expectedCount: 4,
    description: 'Маркированный список с разными буллетами',
  },
  {
    input: 'Покупки: чай зеленый, кофе в зернах, печенье',
    defaultCat: 'task' as const, // проверяем, что префикс перебивает дефолт
    expectedCount: 3,
    description: 'Префикс "Покупки:"',
  },
  {
    input: 'Дела: помыть машину, заехать к родителям',
    defaultCat: 'shopping' as const, // префикс должен перебить
    expectedCount: 2,
    description: 'Префикс "Дела:"',
  },
  {
    input: 'купить колбасу, сосиски и сделать отчет по работе',
    defaultCat: 'shopping' as const,
    expectedCount: 3, // по запятой и союзу "и" с раздельными категориями
    description: 'Смешанные покупки и задачи в одном предложении',
  },
  {
    input: 'Грудка филе',
    defaultCat: 'shopping' as const,
    expectedCount: 1,
    description: 'Одиночный пункт из нескольких слов (Грудка филе)',
  },
];

let passed = 0;

for (const tc of testCases) {
  const result = parseLocal(tc.input, tc.defaultCat);
  const ok = result.length === tc.expectedCount;
  if (ok) {
    passed++;
    console.log(`✅ ${tc.description}: извлечено ${result.length} элементов`);
  } else {
    console.error(`❌ ${tc.description}: ожидалось ${tc.expectedCount}, получено ${result.length}`);
  }
  for (const item of result) {
    console.log(`   [${item.category === 'shopping' ? '🛒' : '📝'}] ${item.text}`);
  }
  console.log('');
}

console.log(`Итог тестов: ${passed}/${testCases.length} пройдено успешно!`);
