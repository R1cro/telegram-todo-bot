import {
  initDatabase,
  getOrCreateUser,
  setUserCategory,
  setLastListMessageId,
  getLastListMessageId,
  isListCompleted,
  addItems,
  getItems,
  toggleItemDone,
  clearCompletedItems,
  getStats,
  clearAllCategoryItems,
} from '../src/db.js';

console.log('🧪 Тестирование SQLite базы данных...\n');

async function run() {
  await initDatabase();
  console.log('✅ Инициализация таблиц прошла успешно');

  const testChatId = 99999999;

  // 1. Создание/получение пользователя
  const user = await getOrCreateUser(testChatId, 'testuser', 'Тестер');
  console.log(`✅ Пользователь создан: chat_id=${user.chat_id}, active_category=${user.active_category}`);

  // Очистим перед тестом
  await clearAllCategoryItems(testChatId, 'shopping');
  await clearAllCategoryItems(testChatId, 'task');

  // 2. Смена категории
  await setUserCategory(testChatId, 'task');
  const userAfterSwitch = await getOrCreateUser(testChatId);
  console.log(`✅ Смена категории: active_category=${userAfterSwitch.active_category}`);

  // 3. Добавление пунктов
  const itemIds = await addItems(testChatId, [
    { category: 'shopping', text: 'Хлеб бородинский' },
    { category: 'shopping', text: 'Молоко 3.2%' },
    { category: 'task', text: 'Позвонить бухгалтеру' },
  ]);
  console.log(`✅ Добавлено пунктов: ${itemIds.length}`);

  // 4. Получение пунктов
  const shoppingItems = await getItems(testChatId, 'shopping');
  const taskItems = await getItems(testChatId, 'task');
  console.log(`✅ Получено: покупок=${shoppingItems.length}, дел=${taskItems.length}`);

  // 5. Переключение статуса выполнения (toggle)
  const firstItemId = shoppingItems[0].id;
  const status1 = await toggleItemDone(testChatId, firstItemId);
  console.log(`✅ Переключение статуса id=${firstItemId}: is_done=${status1}`);

  // 6. Проверка статистики
  const stats = await getStats(testChatId);
  console.log(`✅ Статистика: Покупки ${stats.shoppingDone}/${stats.shoppingTotal}, Дела ${stats.taskDone}/${stats.taskTotal}`);

  // 7. Очистка выполненных
  const deletedDone = await clearCompletedItems(testChatId, 'shopping');
  console.log(`✅ Очистка выполненных: удалено ${deletedDone}`);

  // 8. Финальная проверка количества
  const remainingShopping = await getItems(testChatId, 'shopping');
  console.log(`✅ Осталось покупок: ${remainingShopping.length}`);

  // 9. Тестирование отслеживания ID сообщения списка
  await setLastListMessageId(testChatId, 12345);
  const savedMsgId = await getLastListMessageId(testChatId);
  console.log(`✅ Отслеживание message_id списка: сохранено 12345, получено ${savedMsgId}`);

  // 10. Тестирование проверки завершенности списка (isListCompleted)
  await clearAllCategoryItems(testChatId, 'shopping');
  const emptyCheck = await isListCompleted(testChatId, 'shopping');
  console.log(`✅ Пустой список завершен: ${emptyCheck}`);

  const [idA, idB] = await addItems(testChatId, [
    { category: 'shopping', text: 'Пункт 1' },
    { category: 'shopping', text: 'Пункт 2' },
  ]);
  const incompleteCheck = await isListCompleted(testChatId, 'shopping');
  console.log(`✅ Список с невыполненными пунктами НЕ завершен: ${!incompleteCheck}`);

  await toggleItemDone(testChatId, idA);
  await toggleItemDone(testChatId, idB);
  const completeCheck = await isListCompleted(testChatId, 'shopping');
  console.log(`✅ Список со всеми выполненными пунктами завершен: ${completeCheck}`);

  // Очистка тестовых данных
  await clearAllCategoryItems(testChatId, 'shopping');
  await clearAllCategoryItems(testChatId, 'task');
  console.log('✅ Тестовые данные очищены. Все тесты БД пройдены!\n');
}

run().catch((err) => {
  console.error('❌ Ошибка теста БД:', err);
  process.exit(1);
});
