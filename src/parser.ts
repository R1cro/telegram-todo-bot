import { GoogleGenAI, Type } from '@google/genai';
import { config } from './config.js';
import type { Category } from './db.js';

export interface ParsedItem {
  text: string;
  category: Category;
  quantity?: number;
  extractedBy: 'ai' | 'local';
}

export interface VoiceParseResult {
  success: boolean;
  transcript?: string;
  items: ParsedItem[];
  error?: string;
}

const RUSSIAN_NUMBER_WORDS: Record<string, number> = {
  'один': 1, 'одну': 1, 'одно': 1, 'одна': 1,
  'два': 2, 'две': 2,
  'три': 3,
  'четыре': 4,
  'пять': 5,
  'шесть': 6,
  'семь': 7,
  'восемь': 8,
  'девять': 9,
  'десять': 10,
  'одиннадцать': 11,
  'двенадцать': 12,
  'тринадцать': 13,
  'четырнадцать': 14,
  'пятнадцать': 15,
  'двадцать': 20,
  'тридцать': 30,
  'сорок': 40,
  'пятьдесят': 50,
  'сто': 100,
};

/**
 * Extracts quantity count from item text (e.g. "10 сырков", "мороженое (2 пачки)", "десять сырков").
 */
export function extractQuantity(raw: string): { text: string; quantity: number } {
  let text = raw.trim();
  let quantity = 1;

  // 1. Check parenthesized or trailing quantity: e.g. "Мороженое (2 пачки)", "Сырки - 10 шт", "Кофе 2шт"
  const trailingRegex = /(?:[-—–\s]\s*|\s*\()(\d+)\s*(?:шт|пач(?:ка|ки|ек)|бут(?:ылка|ылки|ылок)|бан(?:ка|ки|ок)|уп(?:аковка|аковки|аковок))?\.?\)?$/iu;
  const trailingMatch = text.match(trailingRegex);
  if (trailingMatch && trailingMatch[1]) {
    const val = parseInt(trailingMatch[1], 10);
    if (!isNaN(val) && val > 0 && val < 1000) {
      quantity = val;
      text = text.slice(0, trailingMatch.index).trim();
    }
  }

  // 2. Check leading digits: e.g. "10 сырков", "2 пачки мороженого", "3 яблока"
  if (quantity === 1) {
    const leadingRegex = /^(\d+)\s*(?:шт|пач(?:ка|ки|ек)|бут(?:ылка|ылки|ылок)|бан(?:ка|ки|ок)|уп(?:аковка|аковки|аковок))?\s*(?:[-—–]\s*)?/iu;
    const leadingMatch = text.match(leadingRegex);
    if (leadingMatch && leadingMatch[1]) {
      const val = parseInt(leadingMatch[1], 10);
      if (!isNaN(val) && val > 0 && val < 1000) {
        quantity = val;
        text = text.slice(leadingMatch[0].length).trim();
      }
    }
  }

  // 3. Check leading Russian word numbers: e.g. "десять сырков", "две пачки мороженого"
  if (quantity === 1) {
    const words = text.split(/\s+/);
    const firstWord = words[0]?.toLowerCase();
    if (firstWord && RUSSIAN_NUMBER_WORDS[firstWord]) {
      quantity = RUSSIAN_NUMBER_WORDS[firstWord];
      let rest = words.slice(1);
      if (rest.length > 0 && /^(?:шт|пач(?:ка|ки|ек)|бут(?:ылка|ылки|ылок)|бан(?:ка|ки|ок)|уп(?:аковка|аковки|аковок))\b/i.test(rest[0])) {
        rest = rest.slice(1);
      }
      text = rest.join(' ').trim();
    }
  }

  return { text: text || raw.trim(), quantity };
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

// General vocabulary for shopping detection (groceries, produce, meats, drinks, household goods, units)
const SHOPPING_WORDS = [
  'купить', 'взять', 'пакет', 'пакеты', 'кг', 'гр', 'грамм', 'шт', 'л', 'литр',
  'банка', 'банки', 'бутылка', 'бутылки', 'хлеб', 'батон', 'молоко', 'сыр', 'мясо',
  'рыба', 'рыбу', 'птица', 'курица', 'курицу', 'филе', 'фарш', 'яйца', 'яйцо',
  'масло', 'овощи', 'фрукты', 'яблоки', 'яблоко', 'бананы', 'банан', 'томаты',
  'помидоры', 'огурцы', 'картошка', 'картофель', 'морковь', 'лук', 'чеснок',
  'чай', 'кофе', 'сахар', 'соль', 'вода', 'воду', 'мыло', 'бумага', 'бумагу',
  'порошок', 'корм', 'колбаса', 'колбасу', 'сосиски', 'макароны', 'крупа', 'гречка',
  'рис', 'шоколад', 'печенье', 'майонез', 'кетчуп', 'сметана', 'творог', 'кефир',
  'йогурт', 'салфетки', 'шампунь', 'паста', 'лекарства', 'аптека', 'таблетки',
  'сок', 'грибы', 'фасоль'
];

// General vocabulary for task and chore detection (actions, calls, appointments, payments)
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
 * Local heuristic parser operating without external network requests.
 */
export function parseLocal(text: string, defaultCategory: Category): ParsedItem[] {
  let forcedCategory: Category | null = null;
  let cleanText = text.trim();

  // Check for explicit message-level category prefix
  if (SHOPPING_PREFIX.test(cleanText)) {
    forcedCategory = 'shopping';
    cleanText = cleanText.replace(SHOPPING_PREFIX, '');
  } else if (TASK_PREFIX.test(cleanText)) {
    forcedCategory = 'task';
    cleanText = cleanText.replace(TASK_PREFIX, '');
  }

  // Split into lines
  const rawLines = cleanText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items: ParsedItem[] = [];

  for (const line of rawLines) {
    // Strip bullet markers: "- ", "* ", "1. ", "1) ", etc.
    const strippedLine = line.replace(/^(\s*[-*•—+>]|\d+[\.\)]|\(\d+\)|\[\d+\])\s*/, '').trim();
    if (!strippedLine) continue;

    // Split line into multiple item fragments if delimiters exist
    const parts = splitLineIntoItems(strippedLine);

    for (const part of parts) {
      let itemText = part.replace(/^[-*•—+>]\s*/, '').trim();
      if (!itemText) continue;

      // Strip common leading action words for cleaner item names
      const normalized = itemText
        .replace(/^(надо\s+|нужно\s+)?(купить|взять|сделать)\s+/i, '')
        .trim();

      const finalText = normalized ? capitalize(normalized) : capitalize(itemText);

      // Determine category based on prefix, keywords, or fallback
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

      const parsedQty = extractQuantity(finalText);
      items.push({
        text: capitalize(parsedQty.text),
        category,
        quantity: parsedQty.quantity,
        extractedBy: 'local',
      });
    }
  }

  return items;
}

export type ProgressCallback = (statusText: string) => Promise<void> | void;

interface RetryOptions {
  maxRetries?: number;
  timeoutMs?: number;
  onProgress?: ProgressCallback;
}

/**
 * Executes a Gemini request with automatic timeout, exponential backoff retries for transient
 * rate-limit/capacity errors (503 UNAVAILABLE, 429 RESOURCE_EXHAUSTED), model fallbacks,
 * and live progress feedback reporting.
 */
async function callGeminiWithRetry(
  client: GoogleGenAI,
  primaryModel: string,
  payload: any,
  options?: RetryOptions
): Promise<any> {
  const maxRetries = options?.maxRetries ?? 1;
  const timeoutMs = options?.timeoutMs ?? 20000;
  const onProgress = options?.onProgress;

  // Primary model first, followed by stable widely-available fallback models
  const candidateModels = Array.from(
    new Set([
      primaryModel,
      ...(primaryModel !== 'gemini-3.8-flash' ? ['gemini-3.8-flash'] : []),
      'gemini-2.0-flash',
      'gemini-3.5-flash',
    ])
  );

  let lastError: any = null;

  for (let modelIdx = 0; modelIdx < candidateModels.length; modelIdx++) {
    const model = candidateModels[modelIdx];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (onProgress) {
          if (attempt === 0 && modelIdx === 0) {
            await onProgress(
              `🎙 <b>Аудио загружено!</b>\n⏳ <i>Gemini AI (${model}) расшифровывает речь и извлекает задачи...</i>`
            );
          } else if (attempt > 0) {
            await onProgress(
              `🔄 <b>Повторная попытка (${attempt + 1}/${maxRetries + 1})</b>\n⏳ <i>Отправка запроса к ${model}...</i>`
            );
          }
        }

        // Wrap call in a timeout promise to prevent indefinite hanging on server spikes
        const callPromise = client.models.generateContent({
          model,
          ...payload,
        });

        let timerId: NodeJS.Timeout;
        const timeoutPromise = new Promise((_, reject) => {
          timerId = setTimeout(
            () => reject(new Error(`Timeout: Gemini request for ${model} took longer than ${Math.round(timeoutMs / 1000)}s`)),
            timeoutMs
          );
        });

        const response = await Promise.race([callPromise, timeoutPromise]);
        clearTimeout(timerId!);
        return response;
      } catch (err: any) {
        lastError = err;
        const msg = String(err?.message || '');

        const isTransient =
          msg.includes('503') ||
          msg.includes('UNAVAILABLE') ||
          msg.includes('high demand') ||
          msg.includes('429') ||
          msg.includes('RESOURCE_EXHAUSTED') ||
          msg.includes('Timeout:');

        const isModelUnavailable =
          msg.includes('not found') ||
          msg.includes('no longer available') ||
          msg.includes('404');

        if (isModelUnavailable) {
          // Switch to next candidate model immediately without delay
          const nextModel = candidateModels[modelIdx + 1];
          if (nextModel && onProgress) {
            await onProgress(
              `🔄 <i>Модель ${model} недоступна. Переключаюсь на ${nextModel}...</i>`
            );
          }
          break;
        }

        if (isTransient && attempt < maxRetries) {
          const delaySec = Math.max(1, Math.round((1500 * Math.pow(1.5, attempt)) / 1000));
          console.warn(`Gemini transient error on ${model} (attempt ${attempt + 1}/${maxRetries}), retrying in ${delaySec}s...`);

          if (onProgress) {
            await onProgress(
              `⏳ <i>Обработка запроса через Gemini AI... Пожалуйста, подождите...</i>`
            );
          }

          await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
          continue;
        }

        // If retries on current model are exhausted, switch to fallback model
        const nextModel = candidateModels[modelIdx + 1];
        if (nextModel && onProgress) {
          await onProgress(
            `⏳ <i>Обработка запроса через резервную модель Gemini...</i>`
          );
        }
        break;
      }
    }
  }

  throw lastError;
}

/**
 * AI-assisted parser using Google Gemini API structured output.
 */
export async function parseWithGemini(text: string, defaultCategory: Category): Promise<ParsedItem[] | null> {
  const client = getGenAiClient();
  if (!client) return null;

  try {
    const prompt = `You are a smart planning assistant.
Extract individual items from the user's message for either a shopping list ("shopping") or a task list ("task").

Instructions:
1. Extract concise, clean items without filler words.
2. If a quantity count is specified (e.g. "десять сырков" -> quantity: 10, "2 пачки мороженого" -> quantity: 2), set "quantity" as an integer (default 1) and keep "text" clean (e.g. "Сырки", not "10 сырков").
3. shopping: groceries, goods, pharmacy, store purchases.
4. task: actions, calls, errands, chores, appointments.
5. Default category if ambiguous: "${defaultCategory}".

User message:
"""${text}"""`;

    const requestConfig = {
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: Type.OBJECT,
        properties: {
          items: {
            type: Type.ARRAY,
            description: 'Extracted todo and shopping items',
            items: {
              type: Type.OBJECT,
              properties: {
                text: {
                  type: Type.STRING,
                  description: 'Clean concise item text without quantity number',
                },
                quantity: {
                  type: Type.INTEGER,
                  description: 'Quantity count (default 1)',
                },
                category: {
                  type: Type.STRING,
                  enum: ['shopping', 'task'],
                  description: 'Target list category',
                },
              },
              required: ['text', 'category'],
            },
          },
        },
        required: ['items'],
      },
    };

    const response = await callGeminiWithRetry(client, config.geminiModel, {
      contents: prompt,
      config: requestConfig,
    });

    if (!response.text) return null;

    const data = JSON.parse(response.text) as {
      items?: Array<{ text: string; quantity?: number; category: string }>;
    };

    if (Array.isArray(data.items) && data.items.length > 0) {
      return data.items
        .filter((it) => it.text && it.text.trim())
        .map((it) => ({
          text: capitalize(it.text.trim()),
          quantity: Math.max(1, Math.round(Number(it.quantity || 1))),
          category: it.category === 'task' ? 'task' : 'shopping',
          extractedBy: 'ai',
        }));
    }

    return null;
  } catch (error) {
    console.error('Error invoking Gemini API, falling back to local parser:', error);
    return null;
  }
}

/**
 * Multimodal AI-assisted voice parser using Google Gemini API.
 * Transcribes audio and extracts shopping items and tasks.
 */
export async function parseVoiceWithGemini(
  audioBase64: string,
  mimeType: string,
  defaultCategory: Category,
  onProgress?: ProgressCallback
): Promise<VoiceParseResult> {
  const client = getGenAiClient();
  if (!client) {
    return {
      success: false,
      items: [],
      error: 'Gemini client not initialized. GEMINI_API_KEY is missing.',
    };
  }

  // Normalize MIME type to standard audio MIME types supported by Gemini
  let cleanMime = (mimeType || 'audio/ogg').split(';')[0].trim().toLowerCase();
  if (cleanMime.includes('ogg')) {
    cleanMime = 'audio/ogg';
  } else if (cleanMime.includes('mp3') || cleanMime.includes('mpeg')) {
    cleanMime = 'audio/mp3';
  } else if (cleanMime.includes('wav')) {
    cleanMime = 'audio/wav';
  }

  try {
    const prompt = `Listen to the attached voice message.
1. Transcribe the speech accurately into the "transcript" field in the original language.
2. Extract all individual shopping items and todo tasks from the speech into the "items" array.
3. If a quantity count is specified (e.g. "десять сырков" -> quantity: 10, "2 пачки мороженого" -> quantity: 2), set "quantity" as an integer (default 1) and keep "text" clean (e.g. "Сырки", not "10 сырков").
4. Categorize each item into "shopping" (groceries, goods, purchases) or "task" (errands, calls, chores, actions).
5. Remove conversational filler words (e.g. "добавь пожалуйста", "надо не забыть").
6. Default category if ambiguous: "${defaultCategory}".`;

    const requestPayload = {
      contents: [
        {
          inlineData: {
            mimeType: cleanMime,
            data: audioBase64,
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
            transcript: {
              type: Type.STRING,
              description: 'Full accurate transcription of the voice message',
            },
            items: {
              type: Type.ARRAY,
              description: 'Extracted todo and shopping items',
              items: {
                type: Type.OBJECT,
                properties: {
                  text: {
                    type: Type.STRING,
                    description: 'Clean concise item text without quantity number',
                  },
                  quantity: {
                    type: Type.INTEGER,
                    description: 'Quantity count (default 1)',
                  },
                  category: {
                    type: Type.STRING,
                    enum: ['shopping', 'task'],
                    description: 'Target list category',
                  },
                },
                required: ['text', 'category'],
              },
            },
          },
          required: ['transcript', 'items'],
        },
      },
    };

    const response = await callGeminiWithRetry(client, config.geminiModel, requestPayload, {
      maxRetries: 1,
      timeoutMs: 20000,
      onProgress,
    });

    if (!response || !response.text) {
      return {
        success: false,
        items: [],
        error: 'Empty response text returned from Gemini API.',
      };
    }

    let cleanedText = response.text.trim();
    if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    }

    let data: { transcript?: string; items?: Array<{ text: string; quantity?: number; category: string }> };
    try {
      data = JSON.parse(cleanedText);
    } catch (parseErr: any) {
      console.error('Failed to parse Gemini JSON output:', cleanedText, parseErr);
      return {
        success: false,
        items: [],
        error: `Некорректный ответ от модели: ${cleanedText.slice(0, 100)}`,
      };
    }

    const transcript = data.transcript?.trim() || '';
    const items: ParsedItem[] = (data.items || [])
      .filter((it) => it.text && it.text.trim())
      .map((it) => ({
        text: capitalize(it.text.trim()),
        quantity: Math.max(1, Math.round(Number(it.quantity || 1))),
        category: it.category === 'task' ? 'task' : 'shopping',
        extractedBy: 'ai',
      }));

    return {
      success: true,
      transcript,
      items,
    };
  } catch (error: any) {
    console.error('Error invoking Gemini voice API:', error);
    return {
      success: false,
      items: [],
      error: error?.message || String(error),
    };
  }
}

/**
 * Hybrid message parser:
 * Routes complex conversational speech to Gemini AI if configured,
 * otherwise falls back to the deterministic local parser.
 */
export async function parseMessage(
  text: string,
  defaultCategory: Category
): Promise<ParsedItem[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Check if text benefits from AI conversational parsing
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

  return parseLocal(trimmed, defaultCategory);
}

function capitalize(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function splitLineIntoItems(line: string): string[] {
  // Split on commas or semicolons when not a URL
  const commaParts = !line.includes('http')
    ? line.split(/[,;]+/).map((p) => p.trim()).filter(Boolean)
    : [line];

  const result: string[] = [];

  for (const part of commaParts) {
    // Split on natural conjunctions ("and", "as well as") if separating distinct items
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
