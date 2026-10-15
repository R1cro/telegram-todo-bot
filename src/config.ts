import dotenv from 'dotenv';
dotenv.config();

export interface AppConfig {
  botToken: string;
  geminiApiKey?: string;
  geminiModel: string;
  dbPath: string;
  isAiEnabled: boolean;
  adminUserIds: number[];
  allowedChatIds: number[];
}

const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const geminiModel = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const dbPath = process.env.DB_PATH || 'file:todo_bot.db';
const adminUserIds = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map((id) => Number(id.trim()))
  .filter((id) => Number.isSafeInteger(id) && id > 0);

const allowedChatIdEnv = process.env.ALLOWED_CHAT_ID || process.env.ALLOWED_CHAT_IDS;
const allowedChatIds = allowedChatIdEnv
  ? allowedChatIdEnv
      .split(',')
      .map((id) => Number(id.trim()))
      .filter((id) => !isNaN(id))
  : [-1003905913984];

export const config: AppConfig = {
  botToken,
  geminiApiKey: geminiApiKey || undefined,
  geminiModel,
  dbPath,
  isAiEnabled: Boolean(geminiApiKey && geminiApiKey.trim().length > 0),
  adminUserIds,
  allowedChatIds,
};

export function validateConfig(): void {
  if (!config.botToken) {
    console.error('❌ ERROR: Missing BOT_TOKEN!');
    console.error('Please configure your .env file with your Telegram bot token:');
    console.error('BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ');
    console.error('\nYou can create a bot and get a token from @BotFather on Telegram: https://t.me/BotFather\n');
  }
}
