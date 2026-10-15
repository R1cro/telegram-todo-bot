import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';
import {
  getProductByBarcode,
  saveOrUpdateProductCatalog,
  setItemPriceAndBarcode,
  getListItems,
  toggleItemDone,
  type TodoItem,
} from './db.js';

export interface ScannedProductData {
  barcode: string | null;
  productName: string | null;
  price: number | null;
}

export interface BarcodeProcessResult {
  success: boolean;
  matchedItem: TodoItem | null;
  productName: string;
  price: number | null;
  barcode: string | null;
  isNewItem: boolean;
  error?: string;
}

/**
 * Normalizes Russian text by stripping punctuation and converting to lowercase.
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:()«»"'%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Basic Russian word stemmer for grocery matching (e.g. "молоко" -> "молок", "сырки" -> "сырк").
 */
function stemWord(word: string): string {
  if (word.length <= 3) return word;
  return word.replace(/(?:ами|ями|ов|ев|ей|ам|ям|ом|ем|а|я|о|е|ы|и|у|ю|ь|ка|ки|ок|ек)$/iu, '');
}

/**
 * Looks up product information from Open Food Facts public database by barcode.
 */
export async function lookupBarcodeOnline(
  barcode: string
): Promise<{ name?: string; price?: number } | null> {
  const cleanBarcode = barcode.trim();
  if (!/^\d{8,14}$/.test(cleanBarcode)) return null;

  // 1. Check weight-based barcodes (internal store standard prefix 20..29 in Russian retail)
  if (cleanBarcode.length === 13 && cleanBarcode.startsWith('2')) {
    const internalPrefix = cleanBarcode.substring(0, 2);
    const prefixNum = parseInt(internalPrefix, 10);
    if (prefixNum >= 20 && prefixNum <= 29) {
      // In Russian retail, digits 8-12 often encode price in kopecks (e.g. 01890 -> 18.90 or 189.00)
      const rawNum = parseInt(cleanBarcode.substring(7, 12), 10);
      if (!isNaN(rawNum) && rawNum > 0) {
        // Typically either price in rubles or grams
        return { name: `Весовой товар (${cleanBarcode.substring(2, 7)})` };
      }
    }
  }

  // 2. Query Open Food Facts API with timeout
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${cleanBarcode}.json`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'TelegramTodoShoppingBot/1.0 (https://github.com/R1cro/telegram-todo-bot)',
      },
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data = (await res.json()) as any;
      if (data && data.status === 1 && data.product) {
        const prod = data.product;
        const name =
          prod.product_name_ru ||
          prod.product_name ||
          prod.generic_name_ru ||
          prod.generic_name;

        if (name && typeof name === 'string' && name.trim().length > 0) {
          const brand = prod.brands ? `${prod.brands} ` : '';
          return { name: `${brand}${name}`.trim() };
        }
      }
    }
  } catch {
    // Online lookup timeout or network failure, safely fall back
  }

  return null;
}

/**
 * Analyzes an image with Gemini Vision to extract barcode digits, product name, and shelf price.
 */
export async function recognizeBarcodeAndProductFromImage(
  imageBuffer: Buffer,
  mimeType: string = 'image/jpeg'
): Promise<ScannedProductData> {
  if (!config.geminiApiKey || !config.isAiEnabled) {
    return { barcode: null, productName: null, price: null };
  }

  const client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  const base64Data = imageBuffer.toString('base64');

  const prompt = `You are an automated barcode scanner and retail product identification assistant.
Inspect the provided camera photo carefully:
1. Locate any product barcode (EAN-13, EAN-8, UPC-A, Code 128, QR code) and extract its numeric digits. If barcode is blurry or absent, return null.
2. Read the product packaging and/or shelf price tag to determine the concise product name in Russian (e.g. "Молоко Домик в деревне 3.2%", "Сыр Российский", "Чипсы Lay's").
3. Detect any shelf price in rubles if a price tag or sticker is visible in the photo. Extract the numeric value (e.g. 89.90 or 150). Do not include currency symbols. If no price is visible, return null.

Return strictly valid JSON with no markdown formatting, matching this schema:
{"barcode": string | null, "productName": string | null, "price": number | null}`;

  try {
    const candidateModels = [config.geminiModel, 'gemini-3.8-flash', 'gemini-3.5-flash'];
    const uniqueModels = Array.from(new Set(candidateModels));

    for (const model of uniqueModels) {
      try {
        const response = await client.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType,
                    data: base64Data,
                  },
                },
                { text: prompt },
              ],
            },
          ],
        });

        const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const cleanJson = text.replace(/```json/gi, '').replace(/```/g, '').trim();

        if (cleanJson) {
          const parsed = JSON.parse(cleanJson);
          return {
            barcode: parsed.barcode ? String(parsed.barcode).replace(/\D+/g, '') : null,
            productName: parsed.productName ? String(parsed.productName).trim() : null,
            price: typeof parsed.price === 'number' && parsed.price > 0 ? parsed.price : null,
          };
        }
      } catch (err) {
        console.warn(`Gemini barcode visual scan failed on model ${model}:`, err);
      }
    }
  } catch (error) {
    console.error('Error in recognizeBarcodeAndProductFromImage:', error);
  }

  return { barcode: null, productName: null, price: null };
}

/**
 * Matches a detected product name or barcode to an existing item in the active shopping list.
 */
export function findMatchingShoppingItem(
  items: TodoItem[],
  productName: string,
  barcode?: string | null
): TodoItem | null {
  // 1. Direct barcode match
  if (barcode) {
    const byBarcode = items.find((i) => i.barcode === barcode);
    if (byBarcode) return byBarcode;
  }

  if (!productName || items.length === 0) return null;

  const normProduct = normalizeText(productName);
  const prodWords = normProduct.split(' ').map(stemWord).filter((w) => w.length > 1);

  let bestMatch: TodoItem | null = null;
  let highestScore = 0;

  for (const item of items) {
    const normItem = normalizeText(item.text);
    const itemWords = normItem.split(' ').map(stemWord).filter((w) => w.length > 1);

    if (itemWords.length === 0) continue;

    // Check token intersection
    let matchedTokens = 0;
    for (const iw of itemWords) {
      if (prodWords.some((pw) => pw.includes(iw) || iw.includes(pw))) {
        matchedTokens++;
      }
    }

    const score = matchedTokens / itemWords.length;
    if (score > highestScore && score >= 0.5) {
      highestScore = score;
      bestMatch = item;
    }
  }

  return bestMatch;
}

/**
 * High-level processor for scanned products:
 * Looks up catalog, queries Open Food Facts, updates the catalog, matches active shopping items,
 * and marks them as completed with price.
 */
export async function processScannedProduct(
  chatId: number,
  activeListId: number,
  input: {
    barcode?: string | null;
    productName?: string | null;
    price?: number | null;
  }
): Promise<BarcodeProcessResult> {
  const cleanBarcode = input.barcode ? input.barcode.trim() : null;
  let finalName = input.productName ? input.productName.trim() : '';
  let finalPrice = input.price !== undefined && input.price !== null && input.price > 0 ? input.price : null;

  // 1. Check local catalog
  if (cleanBarcode) {
    const localCatalog = await getProductByBarcode(cleanBarcode);
    if (localCatalog) {
      if (!finalName) finalName = localCatalog.name;
      if (finalPrice === null && localCatalog.price) finalPrice = localCatalog.price;
    }

    // 2. Query online if name is still missing
    if (!finalName) {
      const online = await lookupBarcodeOnline(cleanBarcode);
      if (online?.name) finalName = online.name;
      if (finalPrice === null && online?.price) finalPrice = online.price;
    }

    // 3. Fallback name if still missing
    if (!finalName) {
      finalName = `Товар (${cleanBarcode})`;
    }

    // 4. Update local catalog with newest price and name
    await saveOrUpdateProductCatalog(cleanBarcode, finalName, finalPrice);
  }

  if (!finalName) {
    return {
      success: false,
      matchedItem: null,
      productName: '',
      price: null,
      barcode: cleanBarcode,
      isNewItem: false,
      error: 'Не удалось определить название товара',
    };
  }

  // 5. Match against active shopping list
  const shoppingItems = await getListItems(activeListId, 'shopping');
  const matched = findMatchingShoppingItem(shoppingItems, finalName, cleanBarcode);

  if (matched) {
    // Mark as completed if not done
    if (!matched.is_done) {
      await toggleItemDone(chatId, matched.id);
    }
    // Update price and barcode
    await setItemPriceAndBarcode(chatId, matched.id, finalPrice, cleanBarcode);

    return {
      success: true,
      matchedItem: matched,
      productName: finalName,
      price: finalPrice,
      barcode: cleanBarcode,
      isNewItem: false,
    };
  }

  return {
    success: true,
    matchedItem: null,
    productName: finalName,
    price: finalPrice,
    barcode: cleanBarcode,
    isNewItem: true,
  };
}
