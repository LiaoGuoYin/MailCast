import type { Env, TelegramBot, TelegramBotSummary } from '../types';

const TELEGRAM_CHAT_ID_RE = /^-?\d+$/;

export interface TelegramDeliveryBot {
  id: number;
  name: string;
  token: string;
}

export function normalizeTelegramBotId(value: unknown): number | null {
  const normalized = typeof value === 'number'
    ? String(value)
    : typeof value === 'string' ? value : '';
  if (!/^\d+$/.test(normalized)) return null;
  const id = Number(normalized);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function telegramChatIdProblem(chatId: string): string | null {
  if (!chatId) return '请填写 Chat ID';
  if (!TELEGRAM_CHAT_ID_RE.test(chatId)) return 'Chat ID 应为纯数字（群组为负数）';
  return null;
}

export async function listTelegramBots(db: D1Database): Promise<TelegramBotSummary[]> {
  const result = await db.prepare(`
    SELECT
      b.id, b.name, b.token_hint, b.username, b.telegram_user_id,
      b.created_at, b.updated_at, COUNT(r.id) AS rule_count
    FROM telegram_bots b
    LEFT JOIN tg_rules r ON r.bot_id = b.id
    GROUP BY b.id
    ORDER BY b.name COLLATE NOCASE ASC, b.id ASC
  `).all<TelegramBotSummary>();
  return result.results;
}

export async function getTelegramBot(
  db: D1Database,
  botId: number,
): Promise<TelegramBot | null> {
  return db.prepare(`
    SELECT id, name, token, token_hint, username, telegram_user_id, created_at, updated_at
    FROM telegram_bots
    WHERE id = ?
  `).bind(botId).first<TelegramBot>();
}

export async function resolveTelegramDeliveryBot(
  env: Env,
  botId: number | null | undefined,
): Promise<TelegramDeliveryBot> {
  if (botId === null || botId === undefined) {
    throw new Error('Telegram 推送未绑定 Bot，请重新配置规则');
  }

  const bot = await getTelegramBot(env.DB, botId);
  if (!bot) throw new Error('绑定的 Telegram Bot 已不存在，请先更新推送规则');
  return { id: bot.id, name: bot.name, token: bot.token };
}
