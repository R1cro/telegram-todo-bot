import { GoogleGenAI, Type } from '@google/genai';
import { config } from './config.js';
import type { ReceiptItemInput } from './db.js';

export interface ScannedReceiptResult {
  success: boolean;
  storeName?: string;
  receiptDate?: string;
  totalAmount?: number;
  items: ReceiptItemInput[];
  rawText?: string;
  error?: string;
}

export type ProgressCallback = (statusText: string) => Promise<void> | void;

export const STANDARD_CATEGORIES = [
  '🥛 Молочные продукты',
  '🥩 Мясо, птица, рыба',
  '🥦 Овощи и фрукты',
  '🥖 Хлеб и выпечка',
  '🧀 Бакалея и сыры',
  '🥤 Напитки',
  '🍫 Сладости и снеки',
  '🧴 Бытовая химия и гигиена',
  '💊 Аптека',
  '📦 Прочее',
] as const;

export function normalizeCategory(rawCat?: string): string {
  if (!rawCat) return '📦 Прочее';
  const c = rawCat.toLowerCase().trim();

  if (
    c.includes('молок') ||
    c.includes('молочн') ||
    c.includes('творог') ||
    c.includes('йогурт') ||
    c.includes('кефир') ||
    c.includes('сметан') ||
    c.includes('сливк') ||
    c.includes('масло слив') ||
    c.includes('сырок') ||
    c.includes('dairy')
  ) {
    return '🥛 Молочные продукты';
  }
  if (
    c.includes('мяс') ||
    c.includes('птиц') ||
    c.includes('рыб') ||
    c.includes('куриц') ||
    c.includes('индейк') ||
    c.includes('фарш') ||
    c.includes('колбас') ||
    c.includes('сосиск') ||
    c.includes('говядин') ||
    c.includes('свинин') ||
    c.includes('ветчин') ||
    c.includes('meat') ||
    c.includes('fish')
  ) {
    return '🥩 Мясо, птица, рыба';
  }
  if (
    c.includes('овощ') ||
    c.includes('фрукт') ||
    c.includes('ягод') ||
    c.includes('зелен') ||
    c.includes('яблок') ||
    c.includes('банан') ||
    c.includes('томат') ||
    c.includes('помидор') ||
    c.includes('огур') ||
    c.includes('картоф') ||
    c.includes('капуст') ||
    c.includes('морков') ||
    c.includes('цитрус') ||
    c.includes('мандарин') ||
    c.includes('апельсин') ||
    c.includes('produce') ||
    c.includes('fruit') ||
    c.includes('vegetable')
  ) {
    return '🥦 Овощи и фрукты';
  }
  if (
    c.includes('хлеб') ||
    c.includes('выпечк') ||
    c.includes('батон') ||
    c.includes('булочк') ||
    c.includes('булк') ||
    c.includes('лаваш') ||
    c.includes('пирог') ||
    c.includes('круассан') ||
    c.includes('бублик') ||
    c.includes('тост') ||
    c.includes('bakery') ||
    c.includes('bread')
  ) {
    return '🥖 Хлеб и выпечка';
  }
  if (
    c.includes('сыр') ||
    c.includes('круп') ||
    c.includes('макарон') ||
    c.includes('паста') ||
    c.includes('гречк') ||
    c.includes('рис') ||
    c.includes('масло раст') ||
    c.includes('мука') ||
    c.includes('соус') ||
    c.includes('майонез') ||
    c.includes('кетчуп') ||
    c.includes('консерв') ||
    c.includes('бакале') ||
    c.includes('приправ') ||
    c.includes('специ') ||
    c.includes('соль') ||
    c.includes('сахар')
  ) {
    return '🧀 Бакалея и сыры';
  }
  if (
    c.includes('напит') ||
    c.includes('сок') ||
    c.includes('вод') ||
    c.includes('газиров') ||
    c.includes('чай') ||
    c.includes('кофе') ||
    c.includes('морс') ||
    c.includes('квас') ||
    c.includes('пиво') ||
    c.includes('drink') ||
    c.includes('beverage')
  ) {
    return '🥤 Напитки';
  }
  if (
    c.includes('сладост') ||
    c.includes('шоколад') ||
    c.includes('конфет') ||
    c.includes('печень') ||
    c.includes('торт') ||
    c.includes('чипс') ||
    c.includes('снек') ||
    c.includes('вафл') ||
    c.includes('десерт') ||
    c.includes('морожен') ||
    c.includes('пряник') ||
    c.includes('зефир') ||
    c.includes('snack') ||
    c.includes('sweet') ||
    c.includes('candy')
  ) {
    return '🍫 Сладости и снеки';
  }
  if (
    c.includes('хим') ||
    c.includes('гигиен') ||
    c.includes('мыл') ||
    c.includes('шампун') ||
    c.includes('порошок') ||
    c.includes('бумаг') ||
    c.includes('салфетк') ||
    c.includes('паста зуб') ||
    c.includes('гель') ||
    c.includes('пакет') ||
    c.includes('cleaning') ||
    c.includes('hygiene')
  ) {
    return '🧴 Бытовая химия и гигиена';
  }
  if (
    c.includes('аптек') ||
    c.includes('лекарств') ||
    c.includes('таблетк') ||
    c.includes('витамин') ||
    c.includes('пластыр') ||
    c.includes('мазь') ||
    c.includes('бинт') ||
    c.includes('pharmacy') ||
    c.includes('med')
  ) {
    return '💊 Аптека';
  }

  for (const std of STANDARD_CATEGORIES) {
    const rawNoEmoji = std.replace(/^[^\s]+\s*/, '');
    if (std === rawCat || rawCat.includes(rawNoEmoji)) {
      return std;
    }
  }

  return '📦 Прочее';
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

/**
 * Scans an image of a purchase receipt and extracts structured items, prices, and totals.
 */
export async function scanReceiptWithGemini(
  imageBase64: string,
  mimeType: string = 'image/jpeg',
  onProgress?: ProgressCallback
): Promise<ScannedReceiptResult> {
  const client = getGenAiClient();
  if (!client) {
    return {
      success: false,
      items: [],
      error: 'Gemini AI не подключен. Пожалуйста, укажите GEMINI_API_KEY в .env',
    };
  }

  const prompt = `Ты — эксперт по чтению и анализу кассовых чеков магазинов РФ и СНГ.
Внимательно изучи прикрепленную фотографию чека и извлеки структурированные данные.

Правила извлечения:
1. Магазин (store_name): Торговая сеть или название магазина (например: "Пятёрочка", "ВкусВилл", "Магнит", "Ашан", "Перекрёсток", "Лента", "Дикси", "Красное&Белое" и т.д.). Если в чеке нет названия магазина, верни null.
2. Дата чека (receipt_date): Дата и время покупки в формате YYYY-MM-DD или YYYY-MM-DDTHH:mm:ss. Если год не указан явно, используй текущий 2026 год. Если дата нечитаема, верни null.
3. Итоговая сумма (total_amount): Финальная общая сумма к оплате с учетом всех скидок (ИТОГ, ИТОГО, К ОПЛАТЕ) в рублях как число (например 1250.70).
4. Товары (items): Список всех купленных позиций:
   - name: очищенное, понятное название товара (например "Молоко 3.2% Домик в деревне", "Батон нарезной", "Сыр Российский", без лишних служебных кодов и номеров кассы).
   - category: одна из подходящих категорий: "Молочные продукты", "Мясо, птица, рыба", "Овощи и фрукты", "Хлеб и выпечка", "Бакалея и сыры", "Напитки", "Сладости и снеки", "Бытовая химия и гигиена", "Аптека", "Прочее".
   - quantity: количество штук или вес в кг (число, по умолчанию 1).
   - unit_price: цена за единицу или кг, если указана (число или null).
   - total_price: итоговая стоимость этой позиции в чеке (число).

Если на фотографии не чек или данные совершенно не различимы, верни total_amount: 0 и пустой массив items.`;

  const requestPayloadWithSchema = {
    contents: [
      {
        inlineData: {
          mimeType: mimeType || 'image/jpeg',
          data: imageBase64,
        },
      },
      {
        text: prompt,
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: Type.OBJECT,
        properties: {
          store_name: {
            type: Type.STRING,
            nullable: true,
            description: 'Name of the store or merchant, e.g. Пятёрочка, ВкусВилл',
          },
          receipt_date: {
            type: Type.STRING,
            nullable: true,
            description: 'Date/time of purchase in ISO or YYYY-MM-DD format',
          },
          total_amount: {
            type: Type.NUMBER,
            description: 'Grand total sum of the receipt in rubles',
          },
          items: {
            type: Type.ARRAY,
            description: 'List of bought items and prices',
            items: {
              type: Type.OBJECT,
              properties: {
                name: {
                  type: Type.STRING,
                  description: 'Clean readable name of the product',
                },
                category: {
                  type: Type.STRING,
                  nullable: true,
                  description: 'Category of product',
                },
                quantity: {
                  type: Type.NUMBER,
                  nullable: true,
                  description: 'Quantity count or weight',
                },
                unit_price: {
                  type: Type.NUMBER,
                  nullable: true,
                  description: 'Price per single unit or kg',
                },
                total_price: {
                  type: Type.NUMBER,
                  description: 'Total price for this line item',
                },
              },
              required: ['name', 'total_price'],
            },
          },
        },
        required: ['total_amount', 'items'],
      },
    },
  };

  const requestPayloadPlainJson = {
    contents: [
      {
        inlineData: {
          mimeType: mimeType || 'image/jpeg',
          data: imageBase64,
        },
      },
      {
        text: prompt + '\nОтветь СТРОГО в формате валидного JSON объекта: {"store_name": "...", "receipt_date": "...", "total_amount": 1234.5, "items": [{"name": "...", "category": "...", "quantity": 1, "unit_price": 100, "total_price": 100}]}',
      },
    ],
    config: {
      responseMimeType: 'application/json',
    },
  };

  const candidateModels = Array.from(
    new Set([
      config.geminiModel,
      'gemini-3.8-flash',
      'gemini-3.5-flash',
    ].filter(Boolean))
  ).filter((m) => !m.includes('2.0') && !m.includes('2.5') && !m.includes('1.5'));

  let lastError: any = null;

  for (let modelIdx = 0; modelIdx < candidateModels.length; modelIdx++) {
    const model = candidateModels[modelIdx];

    if (onProgress) {
      if (modelIdx === 0) {
        await onProgress(`🔍 <b>Нейросеть Gemini AI (${model}) распознаёт чек...</b>\n⏳ <i>Извлекаю позиции, количество и суммы...</i>`);
      } else {
        await onProgress(`🔄 <i>Переключаюсь на резервную модель ${model}...</i>\n⏳ <i>Повторный опрос нейросети...</i>`);
      }
    }

    let modelUnavailable = false;

    // Try first with JSON schema; if that errors with schema validation, try plain JSON
    for (const payload of [requestPayloadWithSchema, requestPayloadPlainJson]) {
      if (modelUnavailable) break;

      try {
        const callPromise = client.models.generateContent({
          model,
          ...payload,
        });

        let timerId: NodeJS.Timeout;
        const timeoutMs = 14000;
        const timeoutPromise = new Promise((_, reject) => {
          timerId = setTimeout(
            () => reject(new Error(`Timeout: запрос к модели ${model} превысил 14 сек.`)),
            timeoutMs
          );
        });

        const response: any = await Promise.race([callPromise, timeoutPromise]);
        clearTimeout(timerId!);

        if (!response || !response.text) {
          continue;
        }

        let cleaned = response.text.trim();
        if (cleaned.startsWith('```')) {
          cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        }

        const parsed = JSON.parse(cleaned) as {
          store_name?: string | null;
          receipt_date?: string | null;
          total_amount?: number;
          items?: Array<{
            name: string;
            category?: string;
            quantity?: number;
            unit_price?: number | null;
            total_price: number;
          }>;
        };

        const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
        const normalizedItems: ReceiptItemInput[] = rawItems
          .filter((it) => it.name && it.name.trim() && !isNaN(Number(it.total_price)))
          .map((it) => ({
            name: it.name.trim(),
            category: normalizeCategory(it.category),
            quantity: it.quantity && it.quantity > 0 ? Number(it.quantity) : 1,
            unit_price: it.unit_price !== undefined && it.unit_price !== null ? Number(it.unit_price) : undefined,
            total_price: Math.max(0, Math.round(Number(it.total_price) * 100) / 100),
          }));

        // Calculate or verify total sum
        const itemsSum = normalizedItems.reduce((acc, curr) => acc + curr.total_price, 0);
        let finalTotal = parsed.total_amount ? Number(parsed.total_amount) : itemsSum;
        if (finalTotal <= 0 && itemsSum > 0) {
          finalTotal = itemsSum;
        }

        if (normalizedItems.length === 0 && finalTotal <= 0) {
          return {
            success: false,
            items: [],
            error: 'На фото не удалось распознать кассовый чек или позиции товаров. Попробуйте сфотографировать чек ближе и при хорошем освещении.',
          };
        }

        // Validate or normalize receipt date
        let finalDate = new Date().toISOString();
        if (parsed.receipt_date) {
          const d = new Date(parsed.receipt_date);
          if (!isNaN(d.getTime())) {
            finalDate = d.toISOString();
          }
        }

        return {
          success: true,
          storeName: parsed.store_name?.trim() || undefined,
          receiptDate: finalDate,
          totalAmount: Math.round(finalTotal * 100) / 100,
          items: normalizedItems,
          rawText: cleaned,
        };
      } catch (err: any) {
        lastError = err;
        const errMsg = String(err?.message || '');
        console.warn(`[Receipt] Gemini attempt failed for model ${model}:`, errMsg);

        if (
          errMsg.includes('not found') ||
          errMsg.includes('404') ||
          errMsg.includes('no longer available') ||
          errMsg.includes('limiting access') ||
          errMsg.includes('User location is not supported')
        ) {
          modelUnavailable = true;
          break;
        }
      }
    }
  }

  console.error('[Receipt] Gemini receipt scanning failed across all models:', lastError);

  let userFriendlyError = lastError?.message || 'ошибка сервиса Gemini';
  if (userFriendlyError.includes('User location is not supported')) {
    userFriendlyError = 'Регион вашего IP-адреса не поддерживается Google Gemini API. Для работы требуется подключение через VPN/прокси.';
  } else if (userFriendlyError.includes('API_KEY_INVALID') || userFriendlyError.includes('API key not valid')) {
    userFriendlyError = 'Неверный GEMINI_API_KEY. Проверьте ключ в файле .env.';
  } else if (userFriendlyError.includes('RESOURCE_EXHAUSTED') || userFriendlyError.includes('429')) {
    userFriendlyError = 'Превышен лимит запросов к Google Gemini API. Пожалуйста, повторите попытку через минуту.';
  }

  return {
    success: false,
    items: [],
    error: `Не удалось распознать чек: ${userFriendlyError}`,
  };
}
