import { GoogleGenAI, Type } from '@google/genai';
import { config } from './config.js';
import type { Category } from './db.js';

export interface ParsedItem {
  text: string;
  category: Category;
  extractedBy: 'ai' | 'local';
}

let genAiClient: GoogleGenAI | null = null;

function getGenAiClient(): GoogleGenAI | null {
  if (!config.geminiApiKey) return null;
  if (!genAiClient) {
    genAiClient = new GoogleGenAI({
      apiKey: config.geminiApiKey,
    });
  }
  return genAiClient;
}

const SHOPPING_WORDS = [
  'купить', 'взять', 'пакет', 'пакеты', 'кг', 'гр', 'грамм', 'шт', 'л', 'литр',
  'банка', 'банки', 'бутылка', 'бутылки', 'хлеб', 'молоко', 'сыр', 'мясо', 'рыба',
  'рыбу', 'яйца', 'яйцо', 'масло', 'овощи', 'фрукты', 'яблоки', 'яблоко', 'бананы',
  'банан', 'чай', 'кофе', 'сахар', 'соль', 'вода', 'воду', 'мыло', 'бумага',
  'бумагу', 'порошок', 'корм', 'колбаса', 'колбасу', 'сосиски', 'макароны', 'крупа',
  'крупу', 'гречка', 'гречку', 'рис', 'шоколад', 'печенье', 'томаты', 'помидоры',
  'помидор', 'огурцы', 'огурец', 'картошка', 'картофель', 'морковь', 'морковку',
  'лук', 'чеснок', 'майонез', 'кетчуп', 'сметана', 'сметану', 'творог', 'кефир',
  'йогурт', 'салфетки', 'шампунь', 'паста', 'пасту', 'лекарства', 'аптека',
  'таблетки', 'вкусняшки', 'пицца', 'пиццу', 'сок'
];

const TASK_WORDS = [
  'сделать', 'позвонить', 'написать', 'отправить', 'оплатить', 'заехать', 'забрать',
  'встретить', 'помыть', 'убрать', 'починить', 'проверить', 'записаться', 'отнести',
  'постирать', 'прочитать', 'подготовить', 'передать', 'согласовать', 'распечатать',
  'напомни', 'напомнить', 'поехать', 'погулять', 'тренировка', 'спортзал', 'врач',
  'врачу', 'банк', 'почта', 'почту', 'квитанция', 'квитанцию', 'счет', 'отчет',
  'договор', 'домашка', 'задача', 'задачи'
];

function buildUnicodeWordRegex(words: string[]): RegExp {
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${words.join('|')})($|[^\\p{L}\\p{N}])`, 'iu');
}

const SHOPPING_REGEX = buildUnicodeWordRegex(SHOPPING_WORDS);
const TASK_REGEX = buildUnicodeWordRegex(TASK_WORDS);

const SHOPPING_PREFIX = /^(покупки|купить|шопинг|список\s+покупок|в\s+магазине|магазин)\s*[:\-]\s*/iu;
const TASK_PREFIX = /^(дела|задачи|сделать|список\s+дел|напоминания|планы|напомни|напомнить)\s*[:\-]\s*/iu;

/**
 * Локальный умный парсер без внешних вызовов
 */
export function parseLocal(text: string, defaultCategory: Category): ParsedItem[] {
  let forcedCategory: Category | null = null;
  let cleanText = text.trim();

  // Проверка префикса на всё сообщение
  if (SHOPPING_PREFIX.test(cleanText)) {
    forcedCategory = 'shopping';
    cleanText = cleanText.replace(SHOPPING_PREFIX, '');
  } else if (TASK_PREFIX.test(cleanText)) {
    forcedCategory = 'task';
    cleanText = cleanText.replace(TASK_PREFIX, '');
  }

  // Разбиваем на строки
  const rawLines = cleanText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items: ParsedItem[] = [];

  for (const line of rawLines) {
    // Очищаем от маркеров списка: "- ", "* ", "1. ", "1) " и т.п.
    const strippedLine = line.replace(/^(\s*[-*•—+>]|\d+[\.\)]|\(\d+\)|\[\d+\])\s*/, '').trim();
    if (!strippedLine) continue;

    // Разбиваем строку на пункты (по запятым, точке с запятой и союзам "и", "а также")
    const parts = splitLineIntoItems(strippedLine);

    for (const part of parts) {
      let itemText = part.replace(/^[-*•—+>]\s*/, '').trim();
      if (!itemText) continue;

      // Убираем вводные слова вроде "купить ", "надо купить ", "сделать " для краткости
      const normalized = itemText
        .replace(/^(надо\s+|нужно\s+)?(купить|взять|сделать)\s+/i, '')
        .trim();

      const finalText = normalized ? capitalize(normalized) : capitalize(itemText);

      // Определение категории
      let category: Category;
      if (forcedCategory) {
        category = forcedCategory;
      } else if (TASK_REGEX.test(itemText)) {
        category = 'task';
      } else if (SHOPPING_REGEX.test(itemText)) {
        category = 'shopping';
      } else {
        category = defaultCategory;
      }

      items.push({
        text: finalText,
        category,
        extractedBy: 'local',
      });
    }
  }

  return items;
}

/**
 * AI-парсер с использованием Gemini API (структурированный вывод)
 */
export async function parseWithGemini(text: string, defaultCategory: Category): Promise<ParsedItem[] | null> {
  const client = getGenAiClient();
  if (!client) return null;

  try {
    const prompt = `Ты — умный ассистент для планирования задач и покупок.
Твоя задача — извлечь из сообщения пользователя отдельные пункты для списка покупок (shopping) или списка дел/задач (task).

Инструкции:
1. Если пользователь пишет свободной речью (например: "Завтра надо заехать в автосервис, а в пятерочке захватить молоко и хлеб"), разбей это на четкие лаконичные пункты.
2. shopping: покупки, товары, продукты, лекарства, вещи в магазине.
3. task: дела, задачи, действия, звонки, встречи, поручения.
4. Очищай текст от лишней воды и слов вежливости, делай названия пунктов емкими (например: "Молоко", "Заехать в автосервис").
5. Категория по умолчанию (если неочевидно): "${defaultCategory}".

Сообщение пользователя:
"""${text}"""`;

    const response = await client.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: Type.OBJECT,
          properties: {
            items: {
              type: Type.ARRAY,
              description: 'Список распознанных пунктов',
              items: {
                type: Type.OBJECT,
                properties: {
                  text: {
                    type: Type.STRING,
                    description: 'Лаконичный текст пункта',
                  },
                  category: {
                    type: Type.STRING,
                    enum: ['shopping', 'task'],
                    description: 'shopping для покупок, task для дел',
                  },
                },
                required: ['text', 'category'],
              },
            },
          },
          required: ['items'],
        },
      },
    });

    if (!response.text) return null;

    const data = JSON.parse(response.text) as {
      items?: Array<{ text: string; category: string }>;
    };

    if (Array.isArray(data.items) && data.items.length > 0) {
      return data.items
        .filter((it) => it.text && it.text.trim())
        .map((it) => ({
          text: capitalize(it.text.trim()),
          category: it.category === 'task' ? 'task' : 'shopping',
          extractedBy: 'ai',
        }));
    }

    return null;
  } catch (error) {
    console.error('Ошибка при обращении к Gemini API (переключаемся на локальный парсер):', error);
    return null;
  }
}

/**
 * Гибридный парсер:
 * Если подключен Gemini и сообщение похоже на сложный живой текст/фразу, используется Gemini.
 * В остальных случаях или при ошибке/отсутствии ключа мгновенно отрабатывает локальный парсер.
 */
export async function parseMessage(
  text: string,
  defaultCategory: Category
): Promise<ParsedItem[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Проверяем, стоит ли вызывать AI
  const isComplexText =
    trimmed.length > 25 &&
    (/\b(завтра|сегодня|послезавтра|нужно|надо|не забыть|хочу|планирую|потом|заодно|вместе с тем)\b/i.test(trimmed) ||
      !trimmed.includes('\n'));

  if (config.isAiEnabled && isComplexText) {
    const aiResults = await parseWithGemini(trimmed, defaultCategory);
    if (aiResults && aiResults.length > 0) {
      return aiResults;
    }
  }

  // Резервный локальный парсер
  return parseLocal(trimmed, defaultCategory);
}

function capitalize(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function splitLineIntoItems(line: string): string[] {
  // Разделяем по запятым и точке с запятой (если не ссылка)
  const commaParts = !line.includes('http')
    ? line.split(/[,;]+/).map((p) => p.trim()).filter(Boolean)
    : [line];

  const result: string[] = [];

  for (const part of commaParts) {
    // Разделяем по союзам " и ", " а также ", если это не единая фраза
    if (/\s+(?:и|а также)\s+/i.test(part) && !part.includes('http')) {
      const subParts = part.split(/\s+(?:и|а также)\s+/i).map((p) => p.trim()).filter(Boolean);
      if (subParts.length > 1 && subParts.every((sp) => sp.length >= 2)) {
        result.push(...subParts);
        continue;
      }
    }
    result.push(part);
  }

  return result;
}

