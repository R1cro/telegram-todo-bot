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
  rawBarcodeText?: string | null;
  notes?: string | null;
}

export interface BarcodeLookupStep {
  sourceId: 'local' | 'gs1' | 'barcode-list' | 'openfoodfacts' | 'upcitemdb' | 'gemini-search';
  sourceName: string;
  status: 'found' | 'not_found' | 'error' | 'skipped';
  resultName?: string;
  details?: string;
}

export interface BarcodeProcessResult {
  success: boolean;
  matchedItem: TodoItem | null;
  productName: string;
  price: number | null;
  barcode: string | null;
  isNewItem: boolean;
  createdItemId?: number;
  lookupSteps: BarcodeLookupStep[];
  resolvedSource?: string;
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

  // 4. Query Open Food Facts / Products Facts
  const offResult = await lookupOpenFoodFacts(cleanBarcode);
  if (offResult && offResult.name) {
    return offResult;
  }

  // 5. Query UPCitemdb database API
  const upcResult = await lookupUpcItemDb(cleanBarcode);
  if (upcResult && upcResult.name) {
    return upcResult;
  }

  return null;
}

/**
 * Queries Open Food Facts, Open Products Facts, and Open Beauty Facts APIs.
 */
export async function lookupOpenFoodFacts(barcode: string): Promise<{ name?: string } | null> {
  const apiHosts = [
    'world.openfoodfacts.org',
    'world.openproductsfacts.org',
    'world.openbeautyfacts.org',
  ];

  for (const host of apiHosts) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const res = await fetch(`https://${host}/api/v2/product/${barcode}.json`, {
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
    } catch {}
  }
  return null;
}

/**
 * Queries UPCitemdb database API.
 */
export async function lookupUpcItemDb(barcode: string): Promise<{ name?: string } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${barcode}`, {
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

  const prompt = `You are a high-precision optical barcode scanner and retail product recognition system.
Examine this image with extreme care:

1. BARCODE / EAN DIGITS (HIGHEST PRIORITY):
- Search the entire image for any product barcode (vertical black and white bars) or QR code.
- Read the digits printed directly underneath or alongside the barcode lines.
- In Russia/CIS, standard retail barcodes (EAN-13) have 13 digits (typically starting with 460-469).
- IMPORTANT: In EAN-13, the first digit (e.g. "4") is frequently printed slightly to the left of the outer guard bars! Do NOT omit the first digit!
- Read all digits cleanly without spaces or dashes (e.g. "4670082523924").
- If the barcode stripes are visible but the numbers are blurry or partially cut off, return whatever digits you can discern in "rawBarcodeText".
- If no barcode or numbers are visible, set barcode to null.

2. PACKAGING / BRAND NAME:
- Read any brand name and product description on the packaging in Russian or English (e.g. "Лакомство Dreamies с курицей 140г").

3. PRICE:
- If a store price tag, discount sticker, or shelf tag is visible, extract the numeric price in rubles (e.g. 149.90 or 89).

Return strictly JSON matching this schema:
{
  "barcode": string | null,
  "rawBarcodeText": string | null,
  "productName": string | null,
  "price": number | null,
  "notes": string | null
}`;

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
          config: {
            responseMimeType: 'application/json',
          },
        });

        const text =
          response.text ||
          response.candidates?.[0]?.content?.parts
            ?.map((p: any) => p.text)
            .filter(Boolean)
            .join('\n') ||
          '';

        let parsed: any = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          const match = text.match(/\{[\s\S]*\}/);
          if (match) {
            try {
              parsed = JSON.parse(match[0]);
            } catch {}
          }
        }

        if (parsed) {
          const rawBc = parsed.barcode || parsed.rawBarcodeText;
          const digits = rawBc ? String(rawBc).replace(/\D+/g, '') : null;
          const validBarcode = digits && digits.length >= 7 && digits.length <= 14 ? digits : null;

          return {
            barcode: validBarcode,
            rawBarcodeText: rawBc ? String(rawBc).trim() : null,
            productName: parsed.productName ? String(parsed.productName).trim() : null,
            price: typeof parsed.price === 'number' && parsed.price > 0 ? parsed.price : null,
            notes: parsed.notes ? String(parsed.notes).trim() : undefined,
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
  let finalName = '';
  let finalPrice = input.price !== undefined && input.price !== null && input.price > 0 ? input.price : null;
  const lookupSteps: BarcodeLookupStep[] = [];
  let resolvedSource: string | undefined = undefined;

  // 1. If barcode is present, prioritize database and registry resolution
  if (cleanBarcode) {
    // 1.1 Weight-based barcode (prefixes 20-29 in retail)
    if (cleanBarcode.length === 13 && cleanBarcode.startsWith('2')) {
      const prefixNum = parseInt(cleanBarcode.substring(0, 2), 10);
      if (prefixNum >= 20 && prefixNum <= 29) {
        finalName = `Весовой товар (${cleanBarcode.substring(2, 7)})`;
        resolvedSource = 'Весовой штрихкод';
        lookupSteps.push({
          sourceId: 'local',
          sourceName: 'Весовой штрихкод',
          status: 'found',
          resultName: finalName,
        });
      }
    }

    // 1.2 Local SQLite catalog
    if (!finalName) {
      try {
        const local = await getProductByBarcode(cleanBarcode);
        if (local && local.name) {
          finalName = local.name;
          if (finalPrice === null && local.price) finalPrice = local.price;
          resolvedSource = 'Локальная база (SQLite)';
          lookupSteps.push({
            sourceId: 'local',
            sourceName: 'Локальная база (SQLite)',
            status: 'found',
            resultName: local.name,
          });
        } else {
          lookupSteps.push({
            sourceId: 'local',
            sourceName: 'Локальная база (SQLite)',
            status: 'not_found',
          });
        }
      } catch (e: any) {
        lookupSteps.push({
          sourceId: 'local',
          sourceName: 'Локальная база (SQLite)',
          status: 'error',
          details: e?.message,
        });
      }
    }

    // 1.3 GS1 Russia (National registrar: id.gs1ru.org)
    if (!finalName) {
      try {
        const gs1 = await lookupGs1Russia(cleanBarcode);
        if (gs1 && gs1.name) {
          finalName = gs1.name;
          resolvedSource = 'GS1 Russia (госреестр РФ)';
          lookupSteps.push({
            sourceId: 'gs1',
            sourceName: 'GS1 Russia (госреестр РФ)',
            status: 'found',
            resultName: gs1.name,
          });
        } else {
          lookupSteps.push({
            sourceId: 'gs1',
            sourceName: 'GS1 Russia (госреестр РФ)',
            status: 'not_found',
          });
        }
      } catch (e: any) {
        lookupSteps.push({
          sourceId: 'gs1',
          sourceName: 'GS1 Russia (госреестр РФ)',
          status: 'error',
          details: e?.message,
        });
      }
    }

    // 1.4 Barcode-list.ru (Retailer Russian catalog)
    if (!finalName) {
      try {
        const bcl = await lookupBarcodeListRu(cleanBarcode);
        if (bcl && bcl.name) {
          finalName = bcl.name;
          resolvedSource = 'Barcode-list.ru';
          lookupSteps.push({
            sourceId: 'barcode-list',
            sourceName: 'Barcode-list.ru',
            status: 'found',
            resultName: bcl.name,
          });
        } else {
          lookupSteps.push({
            sourceId: 'barcode-list',
            sourceName: 'Barcode-list.ru',
            status: 'not_found',
          });
        }
      } catch (e: any) {
        lookupSteps.push({
          sourceId: 'barcode-list',
          sourceName: 'Barcode-list.ru',
          status: 'error',
          details: e?.message,
        });
      }
    }

    // 1.5 Open Food Facts / Open Products Facts
    if (!finalName) {
      try {
        const off = await lookupOpenFoodFacts(cleanBarcode);
        if (off && off.name) {
          finalName = off.name;
          resolvedSource = 'Open Food Facts';
          lookupSteps.push({
            sourceId: 'openfoodfacts',
            sourceName: 'Open Food Facts',
            status: 'found',
            resultName: off.name,
          });
        } else {
          lookupSteps.push({
            sourceId: 'openfoodfacts',
            sourceName: 'Open Food Facts',
            status: 'not_found',
          });
        }
      } catch (e: any) {
        lookupSteps.push({
          sourceId: 'openfoodfacts',
          sourceName: 'Open Food Facts',
          status: 'error',
          details: e?.message,
        });
      }
    }

    // 1.6 UPCitemdb
    if (!finalName) {
      try {
        const upc = await lookupUpcItemDb(cleanBarcode);
        if (upc && upc.name) {
          finalName = upc.name;
          resolvedSource = 'UPCitemdb';
          lookupSteps.push({
            sourceId: 'upcitemdb',
            sourceName: 'UPCitemdb',
            status: 'found',
            resultName: upc.name,
          });
        } else {
          lookupSteps.push({
            sourceId: 'upcitemdb',
            sourceName: 'UPCitemdb',
            status: 'not_found',
          });
        }
      } catch (e: any) {
        lookupSteps.push({
          sourceId: 'upcitemdb',
          sourceName: 'UPCitemdb',
          status: 'error',
          details: e?.message,
        });
      }
    }

    // 1.7 Gemini Search with Google Grounding
    if (!finalName && config.isAiEnabled) {
      try {
        const gem = await lookupBarcodeWithGeminiSearch(cleanBarcode);
        if (gem && gem.name) {
          finalName = gem.name;
          if (finalPrice === null && gem.price) finalPrice = gem.price;
          resolvedSource = 'Поиск Google (Gemini AI)';
          lookupSteps.push({
            sourceId: 'gemini-search',
            sourceName: 'Поиск Google (Gemini AI)',
            status: 'found',
            resultName: gem.name,
          });
        } else {
          lookupSteps.push({
            sourceId: 'gemini-search',
            sourceName: 'Поиск Google (Gemini AI)',
            status: 'not_found',
          });
        }
      } catch (e: any) {
        lookupSteps.push({
          sourceId: 'gemini-search',
          sourceName: 'Поиск Google (Gemini AI)',
          status: 'error',
          details: e?.message,
        });
      }
    }

    // If found by barcode, save to local SQLite catalog
    if (finalName) {
      await saveOrUpdateProductCatalog(cleanBarcode, finalName, finalPrice);
    }
  }

  // 2. Fallback to packaging OCR text if barcode was not in any database
  if (!finalName && input.productName && input.productName.trim().length > 0) {
    finalName = input.productName.trim();
    resolvedSource = 'Текст с упаковки (нейросеть)';
    if (cleanBarcode) {
      await saveOrUpdateProductCatalog(cleanBarcode, finalName, finalPrice);
    }
  }

  if (!finalName) {
    return {
      success: false,
      matchedItem: null,
      productName: '',
      price: null,
      barcode: cleanBarcode,
      isNewItem: false,
      lookupSteps,
      resolvedSource,
      error: 'Товар не найден ни в одной базе данных',
    };
  }

  // 3. Match against active shopping list
  const shoppingItems = await getListItems(activeListId, 'shopping');
  const matched = findMatchingShoppingItem(shoppingItems, finalName, cleanBarcode);

  if (matched) {
    if (!matched.is_done) {
      await toggleItemDone(chatId, matched.id);
    }
    await setItemPriceAndBarcode(chatId, matched.id, finalPrice, cleanBarcode);

    return {
      success: true,
      matchedItem: matched,
      productName: finalName,
      price: finalPrice,
      barcode: cleanBarcode,
      isNewItem: false,
      lookupSteps,
      resolvedSource,
    };
  }

  // 4. Auto-add to shopping list if autoAdd is true
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
      lookupSteps,
      resolvedSource,
    };
  }

  return {
    success: true,
    matchedItem: null,
    productName: finalName,
    price: finalPrice,
    barcode: cleanBarcode,
    isNewItem: true,
    lookupSteps,
    resolvedSource,
  };
}

/**
 * Formats a comprehensive scan report detailing the extracted barcode,
 * product packaging text, shelf price, and database query results.
 */
export function formatBarcodeScanReport(scanned: ScannedProductData, result: BarcodeProcessResult): string {
  let report = '📸 <b>Отчёт анализа фото товара:</b>\n\n';

  // 1. Detected barcode on image
  if (scanned.barcode) {
    report += `🔢 <b>Считанный штрихкод:</b> <code>${scanned.barcode}</code> (${scanned.barcode.length} цифр)\n`;
  } else if (scanned.rawBarcodeText) {
    report += `🔢 <b>Штрихкод на фото:</b> <code>${scanned.rawBarcodeText}</code> ⚠️ <i>(неполный или размыт)</i>\n`;
  } else {
    report += `🔢 <b>Штрихкод на фото:</b> ⚠️ <i>Не обнаружен на изображении</i>\n`;
    report += `  ↳ <i>Причина: полоски штрихкода не в фокусе, засвечены вспышкой/бликом или сняты под острым углом.</i>\n`;
  }

  // 2. Packaging / Price
  if (scanned.productName) {
    report += `🏷 <b>Текст с упаковки:</b> «${scanned.productName}»\n`;
  }
  if (scanned.price) {
    report += `💵 <b>Ценник на фото:</b> ${scanned.price} ₽\n`;
  }
  report += '\n';

  // 3. Database lookup steps
  if (result.lookupSteps && result.lookupSteps.length > 0) {
    report += '🔍 <b>Поиск по базам данных:</b>\n';
    for (const step of result.lookupSteps) {
      if (step.status === 'found') {
        report += `• <b>${step.sourceName}:</b> ✅ Найдено\n  ↳ <i>«${step.resultName}»</i>\n`;
      } else if (step.status === 'not_found') {
        report += `• <b>${step.sourceName}:</b> ❌ <i>Не найден</i>\n`;
      } else if (step.status === 'error') {
        report += `• <b>${step.sourceName}:</b> ⚠️ <i>Ошибка связи (${step.details || 'таймаут'})</i>\n`;
      }
    }
    report += '\n';
  }

  // 4. Final summary & action
  if (result.success && result.matchedItem) {
    const priceText = result.price ? ` (${result.price} ₽)` : '';
    report += `✅ <b>Товар сопоставлен:</b> «${result.productName}»${priceText}\n` +
      `<i>Пункт «${result.matchedItem.text}» в списке покупок отмечен как купленный!</i>`;
  } else if (result.success && result.isNewItem) {
    const priceText = result.price ? ` (${result.price} ₽)` : '';
    report += `✅ <b>Товар добавлен:</b> «${result.productName}»${priceText}\n` +
      `<i>Добавлен в список покупок и отмечен как купленный!</i>`;
  } else if (result.productName) {
    report += `ℹ️ <b>Определён товар:</b> «${result.productName}»\n`;
  } else {
    const codePart = scanned.barcode ? `<code>${scanned.barcode}</code>` : 'на фото';
    report += `⚠️ <b>Причина отсутствия данных:</b>\n` +
      `Штрихкод ${codePart} не найден в госреестре GS1 Russia, базе barcode-list.ru и открытых каталогах.\n\n` +
      `💡 <i>Вы можете добавить товар в список обычным текстом или ввести вручную: <code>/scan ${scanned.barcode || '467...'} [цена]</code></i>`;
  }

  return report;
}
