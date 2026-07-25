import { Hono } from 'hono';
import { rotateAdminCredentials } from '../auth/session';
import { authTokenProblem, hashAuthToken } from '../auth/token';
import {
  getAiConfig,
  getEmailSenderConfig,
  putSetting,
  setEmailSenderAddress,
} from '../settings';
import { getTelegramBot, listTelegramBots } from '../telegram/bots';
import {
  getTelegramBotIdentity,
  TelegramApiError,
  telegramTokenHint,
} from '../telegram/notify';
import type { AiProvider, Env } from '../types';
import { requestIp, safeRecordAuditLog } from '../audit';
import { validateEmailAddress } from '../email/forward';

export const settingsRoutes = new Hono<{ Bindings: Env }>();

const PROVIDERS: AiProvider[] = ['none', 'workers-ai', 'openai'];
const MAX_BOT_NAME_LENGTH = 50;

export function mailDomainFromAddress(value: string | undefined): string {
  const address = value?.trim() ?? '';
  const separator = address.lastIndexOf('@');
  return separator > 0 && separator < address.length - 1
    ? address.slice(separator + 1).toLowerCase()
    : '';
}

function telegramBotErrorPayload(error: unknown) {
  if (error instanceof TelegramApiError) {
    return {
      error: 'Telegram Bot Token 验证失败',
      telegram: {
        error_code: error.errorCode,
        http_status: error.httpStatus,
        description: error.description,
      },
    };
  }
  return { error: 'Telegram Bot Token 验证失败，请稍后重试' };
}

function parseBotId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function validateBotName(value: unknown): string | null {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return '请填写 Bot 名称';
  if (name.length > MAX_BOT_NAME_LENGTH) return `Bot 名称最多 ${MAX_BOT_NAME_LENGTH} 个字符`;
  return null;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('unique constraint');
}

settingsRoutes.get('/', async (c) => {
  const [ai, emailSender] = await Promise.all([
    getAiConfig(c.env.DB),
    getEmailSenderConfig(c.env.DB, c.env.EMAIL_FROM_ADDRESS),
  ]);
  const selectedAddress = emailSender.configured_address || emailSender.environment_address;
  return c.json({
    ai,
    email_sender: {
      ...emailSender,
      binding_configured: Boolean(c.env.EMAIL),
    },
    mail_domain: mailDomainFromAddress(selectedAddress),
  });
});

settingsRoutes.put('/email-sender', async (c) => {
  const body = await c.req.json<{ from_address?: string }>();
  const fromAddress = body.from_address?.trim() ?? '';
  if (fromAddress) {
    const problem = validateEmailAddress(fromAddress);
    if (problem) return c.json({ error: problem }, 400);
  }

  await setEmailSenderAddress(c.env.DB, fromAddress);
  await safeRecordAuditLog(c.env.DB, {
    category: 'settings',
    action: 'settings.email_sender.update',
    status: 'success',
    actor: 'admin',
    targetType: 'email_sender',
    summary: fromAddress ? `邮件发件地址已更新为 ${fromAddress}` : '邮件发件地址已恢复自动选择',
    details: { from_address: fromAddress, source: fromAddress ? 'web' : 'fallback' },
    ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true });
});

settingsRoutes.put('/ai', async (c) => {
  const body = await c.req.json<{
    provider?: string;
    model?: string;
    base_url?: string;
    api_key?: string;
  }>();

  if (!body.provider || !PROVIDERS.includes(body.provider as AiProvider)) {
    return c.json({ error: 'provider must be one of: none, workers-ai, openai' }, 400);
  }
  if (body.provider === 'openai' && !body.api_key?.trim()) {
    return c.json({ error: 'api_key is required for the openai provider' }, 400);
  }
  if (body.base_url && !/^https?:\/\//.test(body.base_url.trim())) {
    return c.json({ error: 'base_url must start with http(s)://' }, 400);
  }

  const config = {
    provider: body.provider as AiProvider,
    model: body.model?.trim() ?? '',
    base_url: body.base_url?.trim() ?? '',
    api_key: body.api_key?.trim() ?? '',
  };

  await putSetting(c.env.DB, 'ai_config', JSON.stringify(config));
  await safeRecordAuditLog(c.env.DB, {
    category: 'settings', action: 'settings.ai.update', status: 'success', actor: 'admin',
    targetType: 'ai_config', summary: `验证码识别配置已更新为 ${config.provider}`,
    details: { provider: config.provider, model: config.model, base_url: config.base_url },
    ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true });
});

settingsRoutes.put('/password', async (c) => {
  const body = await c.req.json<{ new_token?: string }>();
  const token = body.new_token?.trim() ?? '';
  const problem = authTokenProblem(token);

  if (problem) return c.json({ error: problem }, 400);

  const session = await rotateAdminCredentials(c.env.DB, await hashAuthToken(token));
  await safeRecordAuditLog(c.env.DB, {
    category: 'auth', action: 'auth.password.update', status: 'success', actor: 'admin',
    targetType: 'admin_password', summary: '管理密码已修改，历史会话已失效',
    ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true, ...session });
});

settingsRoutes.get('/telegram-bots', async (c) => {
  const data = await listTelegramBots(c.env.DB);
  return c.json({ data });
});

settingsRoutes.post('/telegram-bots', async (c) => {
  const body = await c.req.json<{ name?: string; token?: string }>();
  const name = body.name?.trim() ?? '';
  const token = body.token?.trim() ?? '';
  const nameProblem = validateBotName(name);
  if (nameProblem) return c.json({ error: nameProblem }, 400);
  if (!token) return c.json({ error: '请填写 Bot Token' }, 400);

  let identity;
  try {
    identity = await getTelegramBotIdentity(token);
  } catch (error) {
    await safeRecordAuditLog(c.env.DB, {
      category: 'bot', action: 'bot.create', status: 'failed', actor: 'admin',
      targetType: 'telegram_bot', summary: `添加 Telegram Bot “${name}”失败：Token 验证未通过`,
      details: { name }, ipAddress: requestIp(c.req.raw),
    });
    return c.json(telegramBotErrorPayload(error), 502);
  }

  const now = new Date().toISOString();
  let result: D1Result;
  try {
    result = await c.env.DB.prepare(`
      INSERT INTO telegram_bots
        (name, token, token_hint, username, telegram_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      name,
      token,
      telegramTokenHint(token),
      identity.username,
      identity.id,
      now,
      now,
    ).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return c.json({ error: 'Bot 名称已存在' }, 409);
    }
    throw error;
  }

  const botId = result.meta.last_row_id;
  await safeRecordAuditLog(c.env.DB, {
    category: 'bot', action: 'bot.create', status: 'success', actor: 'admin',
    targetType: 'telegram_bot', targetId: botId,
    summary: `已添加 Telegram Bot “${name}”`,
    details: { name, username: identity.username }, ipAddress: requestIp(c.req.raw),
  });

  return c.json({
    id: botId,
    name,
    token_hint: telegramTokenHint(token),
    username: identity.username,
    telegram_user_id: identity.id,
  }, 201);
});

settingsRoutes.put('/telegram-bots/:id', async (c) => {
  const id = parseBotId(c.req.param('id'));
  if (id === null) return c.json({ error: '无效的 Bot ID' }, 400);

  const existing = await getTelegramBot(c.env.DB, id);
  if (!existing) return c.json({ error: 'Telegram Bot 不存在' }, 404);

  const body = await c.req.json<{ name?: string; token?: string }>();
  const name = body.name?.trim() ?? '';
  const tokenChanged = Boolean(body.token?.trim());
  const token = body.token?.trim() || existing.token;
  const nameProblem = validateBotName(name);
  if (nameProblem) return c.json({ error: nameProblem }, 400);

  let identity;
  try {
    identity = await getTelegramBotIdentity(token);
  } catch (error) {
    await safeRecordAuditLog(c.env.DB, {
      category: 'bot', action: 'bot.update', status: 'failed', actor: 'admin',
      targetType: 'telegram_bot', targetId: id,
      summary: `更新 Telegram Bot “${existing.name}”失败：Token 验证未通过`,
      details: { previous_name: existing.name, requested_name: name, token_changed: tokenChanged },
      ipAddress: requestIp(c.req.raw),
    });
    return c.json(telegramBotErrorPayload(error), 502);
  }

  try {
    await c.env.DB.prepare(`
      UPDATE telegram_bots
      SET name = ?, token = ?, token_hint = ?, username = ?,
          telegram_user_id = ?, updated_at = ?
      WHERE id = ?
    `).bind(
      name,
      token,
      telegramTokenHint(token),
      identity.username,
      identity.id,
      new Date().toISOString(),
      id,
    ).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return c.json({ error: 'Bot 名称已存在' }, 409);
    }
    throw error;
  }

  await safeRecordAuditLog(c.env.DB, {
    category: 'bot', action: 'bot.update', status: 'success', actor: 'admin',
    targetType: 'telegram_bot', targetId: id, summary: `已更新 Telegram Bot “${name}”`,
    details: { previous_name: existing.name, name, username: identity.username, token_changed: tokenChanged },
    ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true });
});

settingsRoutes.post('/telegram-bots/:id/test', async (c) => {
  const id = parseBotId(c.req.param('id'));
  if (id === null) return c.json({ error: '无效的 Bot ID' }, 400);

  const bot = await getTelegramBot(c.env.DB, id);
  if (!bot) return c.json({ error: 'Telegram Bot 不存在' }, 404);

  let identity;
  try {
    identity = await getTelegramBotIdentity(bot.token);
  } catch (error) {
    await safeRecordAuditLog(c.env.DB, {
      category: 'bot', action: 'bot.test', status: 'failed', actor: 'admin',
      targetType: 'telegram_bot', targetId: id, summary: `Telegram Bot “${bot.name}”验证失败`,
      details: { name: bot.name }, ipAddress: requestIp(c.req.raw),
    });
    return c.json(telegramBotErrorPayload(error), 502);
  }

  await c.env.DB.prepare(`
    UPDATE telegram_bots
    SET username = ?, telegram_user_id = ?, updated_at = ?
    WHERE id = ?
  `).bind(identity.username, identity.id, new Date().toISOString(), id).run();

  await safeRecordAuditLog(c.env.DB, {
    category: 'bot', action: 'bot.test', status: 'success', actor: 'admin',
    targetType: 'telegram_bot', targetId: id, summary: `Telegram Bot “${bot.name}”验证成功`,
    details: { name: bot.name, username: identity.username }, ipAddress: requestIp(c.req.raw),
  });

  return c.json({
    success: true,
    username: identity.username,
    telegram_user_id: identity.id,
  });
});

settingsRoutes.delete('/telegram-bots/:id', async (c) => {
  const id = parseBotId(c.req.param('id'));
  if (id === null) return c.json({ error: '无效的 Bot ID' }, 400);

  const bot = await getTelegramBot(c.env.DB, id);
  if (!bot) return c.json({ error: 'Telegram Bot 不存在' }, 404);

  const reference = await c.env.DB.prepare(
    'SELECT COUNT(*) AS count FROM tg_rules WHERE bot_id = ?',
  ).bind(id).first<{ count: number }>();
  if ((reference?.count ?? 0) > 0) {
    return c.json({
      error: `仍有 ${reference?.count} 条推送规则使用此 Bot，请先修改或删除这些规则`,
    }, 409);
  }

  await c.env.DB.prepare('DELETE FROM telegram_bots WHERE id = ?').bind(id).run();
  await safeRecordAuditLog(c.env.DB, {
    category: 'bot', action: 'bot.delete', status: 'success', actor: 'admin',
    targetType: 'telegram_bot', targetId: id, summary: `已删除 Telegram Bot “${bot.name}”`,
    details: { name: bot.name, username: bot.username }, ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true });
});
