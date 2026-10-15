import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';
import {
  getProductByBarcode,
  saveOrUpdateProductCatalog,
  setItemPriceAndBarcode,
  getListItems,
  toggleItemDone,
  addItems,
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
  createdItemId?: number;
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

  // 2. Query official GS1 Russia registry (id.gs1ru.org)
  const gs1Result = await lookupGs1Russia(cleanBarcode);
  if (gs1Result && gs1Result.name) {
    return gs1Result;
  }

  // 3. Query Barcode-list.ru (crowdsourced/retailer Russian database)
  const barcodeListResult = await lookupBarcodeListRu(cleanBarcode);
  if (barcodeListResult && barcodeListResult.name) {
    return barcodeListResult;
  }

  // 4. Query Open Food Facts, Open Products Facts, and Open Beauty Facts APIs
  const apiHosts = [
    'world.openfoodfacts.org',
    'world.openproductsfacts.org',
    'world.openbeautyfacts.org',
  ];

  for (const host of apiHosts) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const res = await fetch(`https://${host}/api/v2/product/${cleanBarcode}.json`, {
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
      // Timeout or network failure on this host, safely try next
    }
  }

  // 5. Query UPCitemdb database API
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${cleanBarcode}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'TelegramTodoShoppingBot/1.0',
      },
    });
    clearTimeout(timeout);
    if (res.ok) {
      const data = (await res.json()) as any;
      if (data && data.code === 'OK' && Array.isArray(data.items) && data.items.length > 0) {
        const item = data.items[0];
        const title = item.title || item.description;
        if (title && typeof title === 'string' && title.trim().length > 0) {
          const brand = item.brand && !title.toLowerCase().includes(item.brand.toLowerCase()) ? `${item.brand} ` : '';
          return { name: `${brand}${title}`.trim() };
        }
      }
    }
  } catch {}

  return null;
}

/**
 * Queries GS1 Russia official national registry (id.gs1ru.org).
 */
export async function lookupGs1Russia(barcode: string): Promise<{ name?: string } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    const res = await fetch(`https://id.gs1ru.org/id/gtin/${barcode}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timeout);

    if (res.ok) {
      const html = await res.text();
      const nameMatch = html.match(/class=["']product-card__header-product-name["'][^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/i);
      if (nameMatch && nameMatch[1]) {
        const rawName = nameMatch[1].trim();
        const brandMatch = html.match(/class=["']product-card__header-brand["'][^>]*>([\s\S]*?)<\/p>/i);
        const brand = brandMatch && brandMatch[1] ? brandMatch[1].trim() : '';

        if (rawName && rawName.length > 0) {
          const fullName = brand && !rawName.toLowerCase().includes(brand.toLowerCase())
            ? `${brand} ${rawName}`
            : rawName;
          return { name: fullName };
        }
      }
    }
  } catch {}
  return null;
}

/**
 * Queries Barcode-list.ru Russian barcode database.
 */
export async function lookupBarcodeListRu(barcode: string): Promise<{ name?: string } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    const res = await fetch(`https://barcode-list.ru/barcode/RU/%D0%9F%D0%BE%D0%B8%D1%81%D0%BA.htm?barcode=${barcode}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    clearTimeout(timeout);

    if (res.ok) {
      const html = await res.text();
      const rowMatch = html.match(/<tr[^>]*>\s*<td[^>]*>\s*\d+\s*<\/td>\s*<td[^>]*>[\d\s]+<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
      if (rowMatch && rowMatch[1]) {
        const rawName = rowMatch[1].replace(/<[^>]+>/g, '').trim();
        if (rawName && rawName.length > 1 && !rawName.includes('Поиск:')) {
          return { name: rawName };
        }
      }
    }
  } catch {}
  return null;
}

/**
 * Looks up real product information using Gemini AI with Google Search Grounding.
 * Searches Google in real-time across retail stores, marketplaces, and registries.
 */
export async function lookupBarcodeWithGeminiSearch(
  barcode: string
): Promise<{ name?: string; price?: number } | null> {
  if (!config.geminiApiKey || !config.isAiEnabled) return null;

  const candidateModels = Array.from(
    new Set([
      config.geminiModel,
      'gemini-3.8-flash',
      'gemini-3.5-flash',
      'gemini-2.5-flash',
      'gemini-1.5-flash',
      'gemini-2.0-flash',
    ].filter(Boolean))
  );

  for (const model of candidateModels) {
    try {
      const client = new GoogleGenAI({ apiKey: config.geminiApiKey });
      const response = await client.models.generateContent({
        model,
        contents: `You are an expert retail product identification assistant for Russia, CIS, and international consumer goods.
Identify the real commercial product with barcode/EAN-13 "${barcode}".
Search Google for this exact barcode across stores (Perekrestok, Magnit, Ozon, Wildberries, VkusVill, Checko, etc.).
Return strictly valid JSON with no markdown formatting:
{"productName": string | null, "price": number | null}`,
        config: {
          tools: [{ googleSearch: {} }],
        },
      });

      const text = response.text || response.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const cleanJson = text.replace(/```json/gi, '').replace(/```/g, '').trim();
      if (cleanJson) {
        const parsed = JSON.parse(cleanJson);
        if (parsed.productName && typeof parsed.productName === 'string' && parsed.productName.trim().length > 0) {
          return {
            name: parsed.productName.trim(),
            price: typeof parsed.price === 'number' && parsed.price > 0 ? parsed.price : undefined,
          };
        }
      }
    } catch (err) {
      // If search tool fails, fallback to direct generative knowledge lookup
      try {
        const client = new GoogleGenAI({ apiKey: config.geminiApiKey });
        const fallbackResp = await client.models.generateContent({
          model,
          contents: `What retail consumer product in Russia corresponds to barcode "${barcode}"? Return only valid JSON: {"productName": string | null}`,
        });
        const fText = fallbackResp.text || fallbackResp.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const fJson = fText.replace(/```json/gi, '').replace(/```/g, '').trim();
        if (fJson) {
          const parsed = JSON.parse(fJson);
          if (parsed.productName && typeof parsed.productName === 'string' && parsed.productName.trim().length > 0) {
            return { name: parsed.productName.trim() };
          }
        }
      } catch {}
    }
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
    const candidateModels = Array.from(
      new Set([
        config.geminiModel,
        'gemini-3.8-flash',
        'gemini-3.5-flash',
        'gemini-2.5-flash',
        'gemini-1.5-flash',
        'gemini-2.0-flash',
      ].filter(Boolean))
    );

    for (const model of candidateModels) {
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
  },
  options: {
    autoAdd?: boolean;
  } = { autoAdd: true }
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

    // 2. Query open databases if name is still missing
    if (!finalName) {
      const online = await lookupBarcodeOnline(cleanBarcode);
      if (online?.name) finalName = online.name;
      if (finalPrice === null && online?.price) finalPrice = online.price;
    }

    // 2.5. Query Gemini with Google Search if still missing
    if (!finalName) {
      const geminiFound = await lookupBarcodeWithGeminiSearch(cleanBarcode);
      if (geminiFound?.name) finalName = geminiFound.name;
      if (finalPrice === null && geminiFound?.price) finalPrice = geminiFound.price;
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

  // 6. Not in the active list: automatically add to shopping list if autoAdd is true
  if (options.autoAdd !== false) {
    const addedIds = await addItems(activeListId, chatId, [
      {
        category: 'shopping',
        text: finalName,
        price: finalPrice,
        barcode: cleanBarcode,
      },
    ]);

    let createdItemId: number | undefined;
    if (addedIds.length > 0) {
      createdItemId = addedIds[0];
      await toggleItemDone(chatId, createdItemId);
    }

    return {
      success: true,
      matchedItem: null,
      productName: finalName,
      price: finalPrice,
      barcode: cleanBarcode,
      isNewItem: true,
      createdItemId,
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
