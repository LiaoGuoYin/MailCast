import { Hono } from 'hono';
import { sendTgTextMessage, TelegramApiError } from '../telegram/notify';
import {
  getTelegramBot,
  normalizeTelegramBotId,
  resolveTelegramDeliveryBot,
  telegramChatIdProblem,
} from '../telegram/bots';
import type { Env, TgRule } from '../types';
import { requestIp, safeRecordAuditLog } from '../audit';
import { getEmailDestination, normalizeDestinationId } from '../email/destinations';
import { getBarkEndpoint, normalizeBarkEndpointId } from '../bark/endpoints';
import { BarkApiError, sendBarkPush } from '../bark/notify';

export const ruleRoutes = new Hono<{ Bindings: Env }>();

const PREFIX_RE = /^(?:\*|[a-zA-Z0-9._-]+)$/;

function validateRulePrefix(prefix: string): string | null {
  if (!prefix) return '请填写收件前缀';
  if (!PREFIX_RE.test(prefix)) return '前缀只能是 *，或包含字母、数字、点、下划线和连字符';
  return null;
}

export function validateForwardRuleInput(prefix: string, destinationId: number | null): string | null {
  const prefixError = validateRulePrefix(prefix);
  if (prefixError) return prefixError;
  if (destinationId === null) return '请选择邮件目标';
  return null;
}

function validateBarkRuleInput(prefix: string, endpointId: number | null): string | null {
  const prefixError = validateRulePrefix(prefix);
  if (prefixError) return prefixError;
  if (endpointId === null) return '请选择 Bark 目标';
  return null;
}

export function validateTgRuleInput(
  prefix: string,
  chatId: string,
  botId: number | null = null,
): string | null {
  const prefixError = validateRulePrefix(prefix);
  if (prefixError) return prefixError;
  const chatIdError = telegramChatIdProblem(chatId);
  if (chatIdError) return chatIdError;
  if (botId === null) return '请选择 Telegram Bot';
  return null;
}

export function telegramTestErrorPayload(error: unknown) {
  if (error instanceof TelegramApiError) {
    return {
      error: 'Telegram 测试消息发送失败',
      telegram: {
        error_code: error.errorCode,
        http_status: error.httpStatus,
        description: error.description,
      },
    };
  }

  return {
    error: '测试消息发送失败，请检查 Bot Token、Chat ID 以及机器人会话权限',
  };
}

// Forward rules

ruleRoutes.get('/forward', async (c) => {
  const result = await c.env.DB.prepare(`
    SELECT r.id, r.prefix, r.destination_id, r.enabled, r.created_at,
           d.name AS destination_name, d.email_address AS target_email
    FROM forward_rules r
    JOIN email_destinations d ON d.id = r.destination_id
    ORDER BY r.created_at DESC
  `).all();
  return c.json(result.results);
});

ruleRoutes.post('/forward', async (c) => {
  const body = await c.req.json<{ prefix?: string; destination_id?: unknown }>();
  const prefix = body.prefix?.trim() ?? '';
  const destinationId = normalizeDestinationId(body.destination_id);
  const validationError = validateForwardRuleInput(prefix, destinationId);

  if (validationError) {
    return c.json({ error: validationError }, 400);
  }
  const destination = await getEmailDestination(c.env.DB, destinationId!);
  if (!destination) return c.json({ error: '选择的邮件目标不存在' }, 400);

  const result = await c.env.DB.prepare(
    'INSERT INTO forward_rules (prefix, destination_id, enabled, created_at) VALUES (?, ?, 1, datetime())'
  ).bind(prefix, destinationId).run();

  await safeRecordAuditLog(c.env.DB, {
    category: 'rule', action: 'rule.forward.create', status: 'success', actor: 'admin',
    targetType: 'forward_rule', targetId: result.meta.last_row_id,
    summary: `已添加邮箱转发规则：${prefix} → ${destination.email_address}`,
    details: { prefix, destination_id: destinationId, target_email: destination.email_address }, ipAddress: requestIp(c.req.raw),
  });

  return c.json({ id: result.meta.last_row_id }, 201);
});

ruleRoutes.put('/forward/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ prefix?: string; destination_id?: unknown }>();
  const prefix = body.prefix?.trim() ?? '';
  const destinationId = normalizeDestinationId(body.destination_id);
  const validationError = validateForwardRuleInput(prefix, destinationId);

  if (validationError) {
    return c.json({ error: validationError }, 400);
  }
  const destination = await getEmailDestination(c.env.DB, destinationId!);
  if (!destination) return c.json({ error: '选择的邮件目标不存在' }, 400);

  const result = await c.env.DB.prepare(
    'UPDATE forward_rules SET prefix = ?, destination_id = ? WHERE id = ?',
  ).bind(prefix, destinationId, id).run();

  if (result.meta.changes === 0) {
    return c.json({ error: '转发规则不存在' }, 404);
  }

  await safeRecordAuditLog(c.env.DB, {
    category: 'rule', action: 'rule.forward.update', status: 'success', actor: 'admin',
    targetType: 'forward_rule', targetId: id,
    summary: `已更新邮箱转发规则：${prefix} → ${destination.email_address}`,
    details: { prefix, destination_id: destinationId, target_email: destination.email_address }, ipAddress: requestIp(c.req.raw),
  });

  return c.json({ success: true });
});

ruleRoutes.patch('/forward/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ enabled?: boolean | number }>();

  if (body.enabled === undefined) {
    return c.json({ error: 'enabled is required' }, 400);
  }

  await c.env.DB.prepare('UPDATE forward_rules SET enabled = ? WHERE id = ?')
    .bind(body.enabled ? 1 : 0, id).run();

  await safeRecordAuditLog(c.env.DB, {
    category: 'rule', action: 'rule.forward.toggle', status: 'success', actor: 'admin',
    targetType: 'forward_rule', targetId: id,
    summary: `邮箱转发规则已${body.enabled ? '启用' : '停用'}`,
    details: { enabled: Boolean(body.enabled) }, ipAddress: requestIp(c.req.raw),
  });

  return c.json({ success: true });
});

ruleRoutes.delete('/forward/:id', async (c) => {
  const id = c.req.param('id');
  const rule = await c.env.DB.prepare(
    `SELECT r.prefix, d.email_address AS target_email
     FROM forward_rules r JOIN email_destinations d ON d.id = r.destination_id
     WHERE r.id = ?`,
  ).bind(id).first<{ prefix: string; target_email: string }>();
  await c.env.DB.prepare('DELETE FROM forward_rules WHERE id = ?').bind(id).run();
  await safeRecordAuditLog(c.env.DB, {
    category: 'rule', action: 'rule.forward.delete', status: 'success', actor: 'admin',
    targetType: 'forward_rule', targetId: id,
    summary: rule
      ? `已删除邮箱转发规则：${rule.prefix} → ${rule.target_email}`
      : `已删除邮箱转发规则 #${id}`,
    details: rule ?? {}, ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true });
});

// Bark rules

ruleRoutes.get('/bark', async (c) => {
  const result = await c.env.DB.prepare(`
    SELECT r.id, r.prefix, r.endpoint_id, r.enabled, r.created_at,
           e.name AS endpoint_name, e.server_url
    FROM bark_rules r
    JOIN bark_endpoints e ON e.id = r.endpoint_id
    ORDER BY r.created_at DESC
  `).all();
  return c.json(result.results);
});

ruleRoutes.post('/bark', async (c) => {
  const body = await c.req.json<{ prefix?: string; endpoint_id?: unknown }>();
  const prefix = body.prefix?.trim() ?? '';
  const endpointId = normalizeBarkEndpointId(body.endpoint_id);
  const problem = validateBarkRuleInput(prefix, endpointId);
  if (problem) return c.json({ error: problem }, 400);
  const endpoint = await getBarkEndpoint(c.env.DB, endpointId!);
  if (!endpoint) return c.json({ error: '选择的 Bark 目标不存在' }, 400);
  const result = await c.env.DB.prepare(
    'INSERT INTO bark_rules (prefix, endpoint_id, enabled, created_at) VALUES (?, ?, 1, datetime())',
  ).bind(prefix, endpointId).run();
  await safeRecordAuditLog(c.env.DB, {
    category: 'rule', action: 'rule.bark.create', status: 'success', actor: 'admin',
    targetType: 'bark_rule', targetId: result.meta.last_row_id,
    summary: `已添加 Bark 规则：${prefix} → ${endpoint.name}`,
    details: { prefix, endpoint_id: endpointId, endpoint_name: endpoint.name }, ipAddress: requestIp(c.req.raw),
  });
  return c.json({ id: result.meta.last_row_id }, 201);
});

ruleRoutes.put('/bark/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ prefix?: string; endpoint_id?: unknown }>();
  const prefix = body.prefix?.trim() ?? '';
  const endpointId = normalizeBarkEndpointId(body.endpoint_id);
  const problem = validateBarkRuleInput(prefix, endpointId);
  if (problem) return c.json({ error: problem }, 400);
  const endpoint = await getBarkEndpoint(c.env.DB, endpointId!);
  if (!endpoint) return c.json({ error: '选择的 Bark 目标不存在' }, 400);
  const result = await c.env.DB.prepare(
    'UPDATE bark_rules SET prefix = ?, endpoint_id = ? WHERE id = ?',
  ).bind(prefix, endpointId, id).run();
  if (result.meta.changes === 0) return c.json({ error: 'Bark 规则不存在' }, 404);
  await safeRecordAuditLog(c.env.DB, {
    category: 'rule', action: 'rule.bark.update', status: 'success', actor: 'admin',
    targetType: 'bark_rule', targetId: id, summary: `已更新 Bark 规则：${prefix} → ${endpoint.name}`,
    details: { prefix, endpoint_id: endpointId, endpoint_name: endpoint.name }, ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true });
});

ruleRoutes.patch('/bark/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ enabled?: boolean | number }>();
  if (body.enabled === undefined) return c.json({ error: 'enabled is required' }, 400);
  const result = await c.env.DB.prepare('UPDATE bark_rules SET enabled = ? WHERE id = ?')
    .bind(body.enabled ? 1 : 0, id).run();
  if (result.meta.changes === 0) return c.json({ error: 'Bark 规则不存在' }, 404);
  await safeRecordAuditLog(c.env.DB, {
    category: 'rule', action: 'rule.bark.toggle', status: 'success', actor: 'admin',
    targetType: 'bark_rule', targetId: id, summary: `Bark 规则已${body.enabled ? '启用' : '停用'}`,
    details: { enabled: Boolean(body.enabled) }, ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true });
});

ruleRoutes.post('/bark/:id/test', async (c) => {
  const id = c.req.param('id');
  const rule = await c.env.DB.prepare(`
    SELECT r.id, r.prefix, r.endpoint_id, e.name AS endpoint_name,
           e.server_url, e.device_key
    FROM bark_rules r JOIN bark_endpoints e ON e.id = r.endpoint_id
    WHERE r.id = ?
  `).bind(id).first<{ id: number; prefix: string; endpoint_id: number; endpoint_name: string; server_url: string; device_key: string }>();
  if (!rule) return c.json({ error: 'Bark 规则不存在' }, 404);
  try {
    await sendBarkPush(rule.server_url, rule.device_key, {
      title: 'MailCast 规则测试',
      body: `Bark 路由配置正常。\n规则前缀：${rule.prefix}`,
    });
  } catch (error) {
    await safeRecordAuditLog(c.env.DB, {
      category: 'delivery', action: 'delivery.bark.rule_test', status: 'failed', actor: 'admin',
      targetType: 'bark_rule', targetId: rule.id,
      summary: `Bark 规则测试失败：${rule.prefix} → ${rule.endpoint_name}`,
      details: { prefix: rule.prefix, endpoint_id: rule.endpoint_id, endpoint_name: rule.endpoint_name },
      ipAddress: requestIp(c.req.raw),
    });
    return c.json({
      error: 'Bark 测试消息发送失败',
      bark: error instanceof BarkApiError ? {
        error_code: error.errorCode,
        http_status: error.httpStatus,
        description: error.description,
      } : error instanceof Error ? { description: error.message } : undefined,
    }, 502);
  }
  await safeRecordAuditLog(c.env.DB, {
    category: 'delivery', action: 'delivery.bark.rule_test', status: 'success', actor: 'admin',
    targetType: 'bark_rule', targetId: rule.id,
    summary: `Bark 规则测试成功：${rule.prefix} → ${rule.endpoint_name}`,
    details: { prefix: rule.prefix, endpoint_id: rule.endpoint_id, endpoint_name: rule.endpoint_name },
    ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true });
});

ruleRoutes.delete('/bark/:id', async (c) => {
  const id = c.req.param('id');
  const rule = await c.env.DB.prepare(`
    SELECT r.prefix, e.name AS endpoint_name FROM bark_rules r
    JOIN bark_endpoints e ON e.id = r.endpoint_id WHERE r.id = ?
  `).bind(id).first<{ prefix: string; endpoint_name: string }>();
  await c.env.DB.prepare('DELETE FROM bark_rules WHERE id = ?').bind(id).run();
  await safeRecordAuditLog(c.env.DB, {
    category: 'rule', action: 'rule.bark.delete', status: 'success', actor: 'admin',
    targetType: 'bark_rule', targetId: id,
    summary: rule ? `已删除 Bark 规则：${rule.prefix} → ${rule.endpoint_name}` : `已删除 Bark 规则 #${id}`,
    details: rule ?? {}, ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true });
});

// TG rules

ruleRoutes.get('/tg', async (c) => {
  const result = await c.env.DB.prepare(`
    SELECT
      r.id, r.prefix, r.chat_id, r.bot_id, r.enabled, r.created_at,
      COALESCE(b.name, '') AS bot_name,
      COALESCE(b.username, '') AS bot_username
    FROM tg_rules r
    LEFT JOIN telegram_bots b ON b.id = r.bot_id
    ORDER BY r.created_at DESC
  `).all<TgRule>();
  return c.json(result.results);
});

ruleRoutes.post('/tg', async (c) => {
  const body = await c.req.json<{ prefix?: string; chat_id?: string; bot_id?: unknown }>();
  const prefix = body.prefix?.trim() ?? '';
  const chatId = body.chat_id?.trim() ?? '';
  const botId = normalizeTelegramBotId(body.bot_id);
  const validationError = validateTgRuleInput(prefix, chatId, botId);

  if (validationError) {
    return c.json({ error: validationError }, 400);
  }
  if (!await getTelegramBot(c.env.DB, botId!)) {
    return c.json({ error: '选择的 Telegram Bot 不存在' }, 400);
  }

  const result = await c.env.DB.prepare(
    'INSERT INTO tg_rules (prefix, chat_id, bot_id, enabled, created_at) VALUES (?, ?, ?, 1, datetime())'
  ).bind(prefix, chatId, botId).run();

  await safeRecordAuditLog(c.env.DB, {
    category: 'rule', action: 'rule.telegram.create', status: 'success', actor: 'admin',
    targetType: 'telegram_rule', targetId: result.meta.last_row_id,
    summary: `已添加 Telegram 规则：${prefix} → ${chatId}`,
    details: { prefix, chat_id: chatId, bot_id: botId }, ipAddress: requestIp(c.req.raw),
  });

  return c.json({ id: result.meta.last_row_id }, 201);
});

ruleRoutes.patch('/tg/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ enabled?: boolean | number }>();

  if (body.enabled === undefined) {
    return c.json({ error: 'enabled is required' }, 400);
  }

  await c.env.DB.prepare('UPDATE tg_rules SET enabled = ? WHERE id = ?')
    .bind(body.enabled ? 1 : 0, id).run();

  await safeRecordAuditLog(c.env.DB, {
    category: 'rule', action: 'rule.telegram.toggle', status: 'success', actor: 'admin',
    targetType: 'telegram_rule', targetId: id,
    summary: `Telegram 规则已${body.enabled ? '启用' : '停用'}`,
    details: { enabled: Boolean(body.enabled) }, ipAddress: requestIp(c.req.raw),
  });

  return c.json({ success: true });
});

ruleRoutes.put('/tg/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ prefix?: string; chat_id?: string; bot_id?: unknown }>();
  const prefix = body.prefix?.trim() ?? '';
  const chatId = body.chat_id?.trim() ?? '';
  const botId = normalizeTelegramBotId(body.bot_id);
  const validationError = validateTgRuleInput(prefix, chatId, botId);

  if (validationError) {
    return c.json({ error: validationError }, 400);
  }
  if (!await getTelegramBot(c.env.DB, botId!)) {
    return c.json({ error: '选择的 Telegram Bot 不存在' }, 400);
  }

  const result = await c.env.DB.prepare(
    'UPDATE tg_rules SET prefix = ?, chat_id = ?, bot_id = ? WHERE id = ?',
  ).bind(prefix, chatId, botId, id).run();

  if (result.meta.changes === 0) {
    return c.json({ error: 'Telegram 规则不存在' }, 404);
  }

  await safeRecordAuditLog(c.env.DB, {
    category: 'rule', action: 'rule.telegram.update', status: 'success', actor: 'admin',
    targetType: 'telegram_rule', targetId: id,
    summary: `已更新 Telegram 规则：${prefix} → ${chatId}`,
    details: { prefix, chat_id: chatId, bot_id: botId }, ipAddress: requestIp(c.req.raw),
  });

  return c.json({ success: true });
});

ruleRoutes.post('/tg/:id/test', async (c) => {
  const id = c.req.param('id');
  const rule = await c.env.DB.prepare('SELECT * FROM tg_rules WHERE id = ?')
    .bind(id)
    .first<TgRule>();

  if (!rule) {
    return c.json({ error: 'Telegram 规则不存在' }, 404);
  }

  let bot;
  try {
    bot = await resolveTelegramDeliveryBot(c.env, rule.bot_id);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Telegram Bot 不可用' }, 503);
  }

  const message = [
    '🧪 MailCast 调试消息',
    '',
    'Telegram 推送配置正常。',
    `规则前缀: ${rule.prefix}`,
    `发送时间: ${new Date().toISOString()}`,
  ].join('\n');

  try {
    await sendTgTextMessage(bot.token, rule.chat_id, message);
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Telegram debug push failed',
      rule_id: rule.id,
    }));

    await safeRecordAuditLog(c.env.DB, {
      category: 'delivery', action: 'delivery.telegram.rule_test', status: 'failed', actor: 'admin',
      targetType: 'telegram_rule', targetId: rule.id,
      summary: `Telegram 规则测试失败：${rule.prefix} → ${rule.chat_id}`,
      details: { prefix: rule.prefix, chat_id: rule.chat_id, bot_id: rule.bot_id },
      ipAddress: requestIp(c.req.raw),
    });

    return c.json(telegramTestErrorPayload(error), 502);
  }

  await safeRecordAuditLog(c.env.DB, {
    category: 'delivery', action: 'delivery.telegram.rule_test', status: 'success', actor: 'admin',
    targetType: 'telegram_rule', targetId: rule.id,
    summary: `Telegram 规则测试成功：${rule.prefix} → ${rule.chat_id}`,
    details: { prefix: rule.prefix, chat_id: rule.chat_id, bot_id: rule.bot_id },
    ipAddress: requestIp(c.req.raw),
  });

  return c.json({ success: true });
});

ruleRoutes.delete('/tg/:id', async (c) => {
  const id = c.req.param('id');
  const rule = await c.env.DB.prepare(
    'SELECT prefix, chat_id, bot_id FROM tg_rules WHERE id = ?',
  ).bind(id).first<{ prefix: string; chat_id: string; bot_id: number }>();
  await c.env.DB.prepare('DELETE FROM tg_rules WHERE id = ?').bind(id).run();
  await safeRecordAuditLog(c.env.DB, {
    category: 'rule', action: 'rule.telegram.delete', status: 'success', actor: 'admin',
    targetType: 'telegram_rule', targetId: id,
    summary: rule
      ? `已删除 Telegram 规则：${rule.prefix} → ${rule.chat_id}`
      : `已删除 Telegram 规则 #${id}`,
    details: rule ?? {}, ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true });
});
