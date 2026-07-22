import { Hono } from 'hono';
import { requestIp, safeRecordAuditLog } from '../audit';
import { getBarkEndpoint, listBarkEndpoints, normalizeBarkEndpointId } from '../bark/endpoints';
import {
  BarkApiError,
  barkKeyHint,
  normalizeBarkServerUrl,
  sendBarkPush,
} from '../bark/notify';
import {
  getEmailDestination,
  listEmailDestinations,
  normalizeDestinationId,
} from '../email/destinations';
import { validateEmailAddress } from '../email/forward';
import type { Env } from '../types';

export const destinationRoutes = new Hono<{ Bindings: Env }>();

const MAX_NAME_LENGTH = 50;

function nameProblem(name: string): string | null {
  if (!name) return '请填写目标名称';
  if (name.length > MAX_NAME_LENGTH) return `目标名称最多 ${MAX_NAME_LENGTH} 个字符`;
  return null;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('unique constraint');
}

function barkErrorPayload(error: unknown) {
  if (error instanceof BarkApiError) {
    return {
      error: 'Bark 推送失败',
      bark: {
        error_code: error.errorCode,
        http_status: error.httpStatus,
        description: error.description,
      },
    };
  }
  return { error: error instanceof Error ? error.message : 'Bark 推送失败，请稍后重试' };
}

destinationRoutes.get('/emails', async (c) => {
  return c.json({ data: await listEmailDestinations(c.env.DB) });
});

destinationRoutes.post('/emails', async (c) => {
  const body = await c.req.json<{ name?: string; email_address?: string }>();
  const name = body.name?.trim() ?? '';
  const emailAddress = body.email_address?.trim().toLowerCase() ?? '';
  const problem = nameProblem(name) || validateEmailAddress(emailAddress);
  if (problem) return c.json({ error: problem }, 400);

  const now = new Date().toISOString();
  let result: D1Result;
  try {
    result = await c.env.DB.prepare(`
      INSERT INTO email_destinations (name, email_address, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).bind(name, emailAddress, now, now).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) return c.json({ error: '名称或邮箱地址已存在' }, 409);
    throw error;
  }

  await safeRecordAuditLog(c.env.DB, {
    category: 'settings', action: 'destination.email.create', status: 'success', actor: 'admin',
    targetType: 'email_destination', targetId: result.meta.last_row_id,
    summary: `已添加邮件目标“${name}”：${emailAddress}`,
    details: { name, email_address: emailAddress }, ipAddress: requestIp(c.req.raw),
  });
  return c.json({ id: result.meta.last_row_id, name, email_address: emailAddress }, 201);
});

destinationRoutes.put('/emails/:id', async (c) => {
  const id = normalizeDestinationId(c.req.param('id'));
  if (id === null) return c.json({ error: '无效的邮件目标 ID' }, 400);
  const existing = await getEmailDestination(c.env.DB, id);
  if (!existing) return c.json({ error: '邮件目标不存在' }, 404);

  const body = await c.req.json<{ name?: string; email_address?: string }>();
  const name = body.name?.trim() ?? '';
  const emailAddress = body.email_address?.trim().toLowerCase() ?? '';
  const problem = nameProblem(name) || validateEmailAddress(emailAddress);
  if (problem) return c.json({ error: problem }, 400);

  try {
    await c.env.DB.prepare(`
      UPDATE email_destinations SET name = ?, email_address = ?, updated_at = ? WHERE id = ?
    `).bind(name, emailAddress, new Date().toISOString(), id).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) return c.json({ error: '名称或邮箱地址已存在' }, 409);
    throw error;
  }
  await safeRecordAuditLog(c.env.DB, {
    category: 'settings', action: 'destination.email.update', status: 'success', actor: 'admin',
    targetType: 'email_destination', targetId: id, summary: `已更新邮件目标“${name}”`,
    details: { previous_name: existing.name, name, email_address: emailAddress },
    ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true });
});

destinationRoutes.delete('/emails/:id', async (c) => {
  const id = normalizeDestinationId(c.req.param('id'));
  if (id === null) return c.json({ error: '无效的邮件目标 ID' }, 400);
  const existing = await getEmailDestination(c.env.DB, id);
  if (!existing) return c.json({ error: '邮件目标不存在' }, 404);
  if (existing.rule_count > 0) {
    return c.json({ error: `仍有 ${existing.rule_count} 条转发规则使用此目标，请先修改或删除这些规则` }, 409);
  }
  await c.env.DB.prepare('DELETE FROM email_destinations WHERE id = ?').bind(id).run();
  await safeRecordAuditLog(c.env.DB, {
    category: 'settings', action: 'destination.email.delete', status: 'success', actor: 'admin',
    targetType: 'email_destination', targetId: id, summary: `已删除邮件目标“${existing.name}”`,
    details: { name: existing.name, email_address: existing.email_address },
    ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true });
});

destinationRoutes.get('/bark', async (c) => {
  return c.json({ data: await listBarkEndpoints(c.env.DB) });
});

destinationRoutes.post('/bark', async (c) => {
  const body = await c.req.json<{ name?: string; server_url?: string; device_key?: string }>();
  const name = body.name?.trim() ?? '';
  const deviceKey = body.device_key?.trim() ?? '';
  const problem = nameProblem(name);
  if (problem) return c.json({ error: problem }, 400);
  if (!deviceKey) return c.json({ error: '请填写 Bark Device Key' }, 400);
  if (deviceKey.length > 512) return c.json({ error: 'Bark Device Key 最多 512 个字符' }, 400);

  let serverUrl: string;
  try {
    serverUrl = normalizeBarkServerUrl(body.server_url || 'https://api.day.app');
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Bark Server 地址无效' }, 400);
  }
  const now = new Date().toISOString();
  let result: D1Result;
  try {
    result = await c.env.DB.prepare(`
      INSERT INTO bark_endpoints
        (name, server_url, device_key, key_hint, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(name, serverUrl, deviceKey, barkKeyHint(deviceKey), now, now).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) return c.json({ error: 'Bark 目标名称已存在' }, 409);
    throw error;
  }
  await safeRecordAuditLog(c.env.DB, {
    category: 'settings', action: 'destination.bark.create', status: 'success', actor: 'admin',
    targetType: 'bark_endpoint', targetId: result.meta.last_row_id,
    summary: `已添加 Bark 目标“${name}”`, details: { name, server_url: serverUrl },
    ipAddress: requestIp(c.req.raw),
  });
  return c.json({ id: result.meta.last_row_id, name, server_url: serverUrl, key_hint: barkKeyHint(deviceKey) }, 201);
});

destinationRoutes.put('/bark/:id', async (c) => {
  const id = normalizeBarkEndpointId(c.req.param('id'));
  if (id === null) return c.json({ error: '无效的 Bark 目标 ID' }, 400);
  const existing = await getBarkEndpoint(c.env.DB, id);
  if (!existing) return c.json({ error: 'Bark 目标不存在' }, 404);
  const body = await c.req.json<{ name?: string; server_url?: string; device_key?: string }>();
  const name = body.name?.trim() ?? '';
  const deviceKey = body.device_key?.trim() || existing.device_key;
  const problem = nameProblem(name);
  if (problem) return c.json({ error: problem }, 400);
  if (deviceKey.length > 512) return c.json({ error: 'Bark Device Key 最多 512 个字符' }, 400);
  let serverUrl: string;
  try {
    serverUrl = normalizeBarkServerUrl(body.server_url || existing.server_url);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Bark Server 地址无效' }, 400);
  }
  try {
    await c.env.DB.prepare(`
      UPDATE bark_endpoints
      SET name = ?, server_url = ?, device_key = ?, key_hint = ?, updated_at = ?
      WHERE id = ?
    `).bind(name, serverUrl, deviceKey, barkKeyHint(deviceKey), new Date().toISOString(), id).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) return c.json({ error: 'Bark 目标名称已存在' }, 409);
    throw error;
  }
  await safeRecordAuditLog(c.env.DB, {
    category: 'settings', action: 'destination.bark.update', status: 'success', actor: 'admin',
    targetType: 'bark_endpoint', targetId: id, summary: `已更新 Bark 目标“${name}”`,
    details: { previous_name: existing.name, name, server_url: serverUrl, key_changed: Boolean(body.device_key?.trim()) },
    ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true });
});

destinationRoutes.post('/bark/:id/test', async (c) => {
  const id = normalizeBarkEndpointId(c.req.param('id'));
  if (id === null) return c.json({ error: '无效的 Bark 目标 ID' }, 400);
  const endpoint = await getBarkEndpoint(c.env.DB, id);
  if (!endpoint) return c.json({ error: 'Bark 目标不存在' }, 404);
  try {
    await sendBarkPush(endpoint.server_url, endpoint.device_key, {
      title: 'MailCast 测试',
      body: `Bark 推送配置正常。\n发送时间：${new Date().toISOString()}`,
    });
  } catch (error) {
    await safeRecordAuditLog(c.env.DB, {
      category: 'delivery', action: 'delivery.bark.endpoint_test', status: 'failed', actor: 'admin',
      targetType: 'bark_endpoint', targetId: id, summary: `Bark 目标“${endpoint.name}”测试失败`,
      details: { name: endpoint.name, server_url: endpoint.server_url }, ipAddress: requestIp(c.req.raw),
    });
    return c.json(barkErrorPayload(error), 502);
  }
  await safeRecordAuditLog(c.env.DB, {
    category: 'delivery', action: 'delivery.bark.endpoint_test', status: 'success', actor: 'admin',
    targetType: 'bark_endpoint', targetId: id, summary: `Bark 目标“${endpoint.name}”测试成功`,
    details: { name: endpoint.name, server_url: endpoint.server_url }, ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true });
});

destinationRoutes.delete('/bark/:id', async (c) => {
  const id = normalizeBarkEndpointId(c.req.param('id'));
  if (id === null) return c.json({ error: '无效的 Bark 目标 ID' }, 400);
  const existing = await getBarkEndpoint(c.env.DB, id);
  if (!existing) return c.json({ error: 'Bark 目标不存在' }, 404);
  const reference = await c.env.DB.prepare(
    'SELECT COUNT(*) AS count FROM bark_rules WHERE endpoint_id = ?',
  ).bind(id).first<{ count: number }>();
  if ((reference?.count ?? 0) > 0) {
    return c.json({ error: `仍有 ${reference?.count} 条 Bark 规则使用此目标，请先修改或删除这些规则` }, 409);
  }
  await c.env.DB.prepare('DELETE FROM bark_endpoints WHERE id = ?').bind(id).run();
  await safeRecordAuditLog(c.env.DB, {
    category: 'settings', action: 'destination.bark.delete', status: 'success', actor: 'admin',
    targetType: 'bark_endpoint', targetId: id, summary: `已删除 Bark 目标“${existing.name}”`,
    details: { name: existing.name, server_url: existing.server_url }, ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true });
});
