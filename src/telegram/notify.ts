import {
  DEFAULT_TG_SUMMARY_MAX_CHARS,
  extractCleanEmailText,
  summarizeEmailText,
} from '../email/text';

export interface TgEmail {
  from: string;
  to: string;
  subject: string;
  body: string;
  htmlBody?: string;
  code?: string | null;
  summary?: string | null;
}

export interface TelegramBotIdentity {
  id: string;
  username: string;
}

const MAX_LENGTH = 4096;
const MAX_ERROR_DESCRIPTION_LENGTH = 500;

export class TelegramApiError extends Error {
  constructor(
    public readonly errorCode: number | null,
    public readonly description: string,
    public readonly httpStatus: number | null,
  ) {
    super(description);
    this.name = 'TelegramApiError';
  }
}

function truncateMessage(text: string): string {
  if (text.length <= MAX_LENGTH) return text;
  let cut = text.slice(0, MAX_LENGTH - 1);
  const lastCodeUnit = cut.charCodeAt(cut.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

export function formatTgNotification(email: TgEmail): string {
  const codeLine = email.code ? `🔑 验证码: ${email.code}\n\n` : '';
  const subject = email.subject?.trim() || '（无主题）';
  const header = `${codeLine}From: ${email.from}\nTo: ${email.to}\nSubject: ${subject}\n\n`;

  const aiSummary = email.summary?.trim();
  if (aiSummary) {
    const boundedSummary = summarizeEmailText(aiSummary, DEFAULT_TG_SUMMARY_MAX_CHARS);
    return truncateMessage(`${header}📝 摘要: ${boundedSummary}`);
  }

  const cleanText = extractCleanEmailText({
    text_body: email.body,
    html_body: email.htmlBody,
    subject: email.subject,
  });
  const excerpt = summarizeEmailText(cleanText, DEFAULT_TG_SUMMARY_MAX_CHARS);
  return truncateMessage(`${header}${excerpt || '（无纯文本正文）'}`);
}

function readTelegramResult(value: unknown): {
  ok: boolean;
  errorCode: number | null;
  description: string | null;
} {
  if (!value || typeof value !== 'object') {
    return { ok: false, errorCode: null, description: null };
  }

  const ok = Reflect.get(value, 'ok');
  const errorCode = Reflect.get(value, 'error_code');
  const description = Reflect.get(value, 'description');
  return {
    ok: ok === true,
    errorCode: typeof errorCode === 'number' && Number.isInteger(errorCode) ? errorCode : null,
    description: typeof description === 'string'
      ? description.slice(0, MAX_ERROR_DESCRIPTION_LENGTH)
      : null,
  };
}

export function telegramTokenHint(token: string): string {
  const trimmed = token.trim();
  return trimmed.length <= 4 ? trimmed : trimmed.slice(-4);
}

async function callTelegramApi(
  botToken: string,
  method: string,
  init?: RequestInit,
): Promise<{ resp: Response; body: unknown }> {
  let resp: Response;
  try {
    resp = init
      ? await fetch(`https://api.telegram.org/bot${botToken}/${method}`, init)
      : await fetch(`https://api.telegram.org/bot${botToken}/${method}`);
  } catch {
    console.error(JSON.stringify({ message: `Telegram ${method} request failed` }));
    throw new TelegramApiError(null, '无法连接 Telegram API', null);
  }

  const responseBody: unknown = await resp.json().catch(() => null);
  const result = readTelegramResult(responseBody);
  if (!resp.ok || !result.ok) {
    console.error(JSON.stringify({
      message: `Telegram ${method} failed`,
      status: resp.status,
      description: result.description,
    }));
    throw new TelegramApiError(
      result.errorCode ?? (resp.status || null),
      result.description ?? 'Telegram API 返回了无法解析的错误响应',
      resp.status || null,
    );
  }
  return { resp, body: responseBody };
}

export async function getTelegramBotIdentity(botToken: string): Promise<TelegramBotIdentity> {
  if (!botToken.trim()) {
    throw new Error('Telegram Bot Token is not configured');
  }

  const { resp, body: responseBody } = await callTelegramApi(botToken, 'getMe');

  const rawResult = responseBody && typeof responseBody === 'object'
    ? Reflect.get(responseBody, 'result')
    : null;
  if (!rawResult || typeof rawResult !== 'object') {
    throw new TelegramApiError(null, 'Telegram API 未返回 Bot 身份信息', resp.status || null);
  }

  const id = Reflect.get(rawResult, 'id');
  const username = Reflect.get(rawResult, 'username');
  return {
    id: typeof id === 'number' || typeof id === 'string' ? String(id) : '',
    username: typeof username === 'string' ? username : '',
  };
}

export async function sendTgTextMessage(
  botToken: string,
  chatId: string,
  message: string,
): Promise<void> {
  if (!botToken.trim()) {
    throw new Error('Telegram Bot Token is not configured');
  }

  await callTelegramApi(botToken, 'sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: truncateMessage(message) }),
  });
}

export async function sendTgNotification(
  botToken: string,
  chatId: string,
  email: TgEmail,
): Promise<void> {
  await sendTgTextMessage(botToken, chatId, formatTgNotification(email));
}
