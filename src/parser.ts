import { GoogleGenAI, Type } from '@google/genai';
import { config } from './config.js';
import type { Category } from './db.js';

export interface ParsedItem {
  text: string;
  category: Category;
  extractedBy: 'ai' | 'local';
}

export interface VoiceParseResult {
  success: boolean;
  transcript?: string;
  items: ParsedItem[];
  error?: string;
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
2. shopping: groceries, goods, pharmacy, store purchases.
3. task: actions, calls, errands, chores, appointments.
4. Default category if ambiguous: "${defaultCategory}".

User message:
"""${text}"""`;

    const response = await client.models.generateContent({
      model: config.geminiModel,
      contents: prompt,
      config: {
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
                    description: 'Clean concise item text',
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
  defaultCategory: Category
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
3. Categorize each item into "shopping" (groceries, goods, purchases) or "task" (errands, calls, chores, actions).
4. Remove conversational filler words (e.g. "добавь пожалуйста", "надо не забыть").
5. Default category if ambiguous: "${defaultCategory}".`;

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
                    description: 'Clean concise item text',
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

    let response;
    try {
      response = await client.models.generateContent({
        model: config.geminiModel,
        ...requestPayload,
      });
    } catch (modelErr: any) {
      if (String(modelErr?.message).includes('not found') && config.geminiModel !== 'gemini-1.5-flash') {
        console.warn(`Model ${config.geminiModel} not found, retrying with gemini-1.5-flash...`);
        response = await client.models.generateContent({
          model: 'gemini-1.5-flash',
          ...requestPayload,
        });
      } else {
        throw modelErr;
      }
    }

    if (!response.text) {
      return {
        success: false,
        items: [],
        error: 'Empty response text returned from Gemini API.',
      };
    }

    const data = JSON.parse(response.text) as {
      transcript?: string;
      items?: Array<{ text: string; category: string }>;
    };

    const transcript = data.transcript?.trim() || '';
    const items: ParsedItem[] = (data.items || [])
      .filter((it) => it.text && it.text.trim())
      .map((it) => ({
        text: capitalize(it.text.trim()),
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
