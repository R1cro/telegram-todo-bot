import dotenv from 'dotenv';
dotenv.config();

export interface AppConfig {
  botToken: string;
  geminiApiKey?: string;
  dbPath: string;
  isAiEnabled: boolean;
}

const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const dbPath = process.env.DB_PATH || 'file:todo_bot.db';

export const config: AppConfig = {
  botToken,
  geminiApiKey: geminiApiKey || undefined,
  dbPath,
  isAiEnabled: Boolean(geminiApiKey && geminiApiKey.trim().length > 0),
};

export function validateConfig(): void {
  if (!config.botToken) {
    console.error('❌ ERROR: Missing BOT_TOKEN!');
    console.error('Please configure your .env file with your Telegram bot token:');
    console.error('BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ');
    console.error('\nYou can create a bot and get a token from @BotFather on Telegram: https://t.me/BotFather\n');
  }
}
