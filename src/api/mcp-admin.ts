import { Hono } from 'hono';
import { requestIp, safeRecordAuditLog } from '../audit';
import {
  createAgentToken,
  getAgentTokenById,
  listAgentTokens,
  normalizeAgentTokenId,
  parseCreateAgentTokenInput,
  revokeAgentToken,
  revokeAllAgentTokens,
} from '../auth/agent-token';
import {
  getEmailSenderConfig,
  getMcpSettings,
  selectedSenderAddress,
  setMcpSettings,
} from '../settings';
import {
  getInstanceAgentDaySendCount,
  listKnownPrefixes,
} from '../services/mail-query';
import { latestReceivingAddress, mailDomainFromAddress } from './settings';
import type { Env } from '../types';

export const mcpAdminRoutes = new Hono<{ Bindings: Env }>();

mcpAdminRoutes.get('/', async (c) => {
  const [settings, tokens, knownPrefixes, senderConfig, latestToAddr, instanceDayUsed] =
    await Promise.all([
      getMcpSettings(c.env.DB),
      listAgentTokens(c.env.DB),
      listKnownPrefixes(c.env.DB),
      getEmailSenderConfig(c.env.DB, c.env.EMAIL_FROM_ADDRESS),
      latestReceivingAddress(c.env.DB),
      getInstanceAgentDaySendCount(c.env.DB),
    ]);

  const receiveDomain = mailDomainFromAddress(latestToAddr);
  const sendDomain = mailDomainFromAddress(selectedSenderAddress(senderConfig)) || receiveDomain;

  return c.json({
    settings,
    tokens,
    known_prefixes: knownPrefixes,
    domains: {
      send_domain: sendDomain,
      receive_domain: receiveDomain,
    },
    endpoint_path: '/mcp',
    usage: {
      instance_day_used: instanceDayUsed,
    },
  });
});

mcpAdminRoutes.put('/', async (c) => {
  const body = await c.req.json<{ enabled?: unknown; daily_send_limit?: unknown }>().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ error: '无效的请求格式' }, 400);
  }
  if (typeof body.enabled !== 'boolean') {
    return c.json({ error: 'enabled 必须是布尔值' }, 400);
  }
  const limitNum = typeof body.daily_send_limit === 'number'
    ? body.daily_send_limit
    : typeof body.daily_send_limit === 'string' && /^\d+$/.test(body.daily_send_limit.trim())
      ? Number(body.daily_send_limit.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(limitNum) || limitNum < 0 || limitNum > 10_000) {
    return c.json({ error: '实例每日 Agent 发信上限需为 0–10000 的整数' }, 400);
  }

  await setMcpSettings(c.env.DB, {
    enabled: body.enabled,
    daily_send_limit: limitNum,
  });

  await safeRecordAuditLog(c.env.DB, {
    category: 'settings',
    action: 'settings.mcp.update',
    status: 'success',
    actor: 'admin',
    targetType: 'mcp_settings',
    summary: `Agent MCP 接入已${body.enabled ? '启用' : '停用'}（实例每日发信上限 ${limitNum} 封）`,
    details: { enabled: body.enabled, daily_send_limit: limitNum },
    ipAddress: requestIp(c.req.raw),
  });

  return c.json({
    success: true,
    settings: { enabled: body.enabled, daily_send_limit: limitNum },
  });
});

mcpAdminRoutes.post('/tokens', async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  const parsed = parseCreateAgentTokenInput(body);
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400);
  }

  const created = await createAgentToken(c.env.DB, parsed.data);

  await safeRecordAuditLog(c.env.DB, {
    category: 'auth',
    action: 'auth.agent_token.create',
    status: 'success',
    actor: 'admin',
    targetType: 'agent_token',
    targetId: created.item.id,
    summary: `已创建 Agent Token「${created.item.name}」`,
    details: {
      name: created.item.name,
      scopes: created.item.scopes,
      prefixes: created.item.prefixes,
      allow_plus_tags: created.item.allow_plus_tags,
      recipient_policy: created.item.recipient_policy,
      send_limit_hour: created.item.send_limit_hour,
      send_limit_day: created.item.send_limit_day,
      expires_at: created.item.expires_at,
    },
    ipAddress: requestIp(c.req.raw),
  });

  return c.json(created, 201);
});

mcpAdminRoutes.post('/tokens/revoke-all', async (c) => {
  const revokedCount = await revokeAllAgentTokens(c.env.DB);
  await safeRecordAuditLog(c.env.DB, {
    category: 'auth',
    action: 'auth.agent_token.revoke_all',
    status: 'success',
    actor: 'admin',
    targetType: 'agent_token',
    summary: `已吊销全部有效 Agent Token（共 ${revokedCount} 个）`,
    details: { revoked_count: revokedCount },
    ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true, revoked_count: revokedCount });
});

mcpAdminRoutes.post('/tokens/:id/revoke', async (c) => {
  const id = normalizeAgentTokenId(c.req.param('id'));
  if (id === null) {
    return c.json({ error: '无效的 Token ID' }, 400);
  }

  const existing = await getAgentTokenById(c.env.DB, id);
  if (!existing) {
    return c.json({ error: 'Agent Token 不存在' }, 404);
  }

  await revokeAgentToken(c.env.DB, id);
  await safeRecordAuditLog(c.env.DB, {
    category: 'auth',
    action: 'auth.agent_token.revoke',
    status: 'success',
    actor: 'admin',
    targetType: 'agent_token',
    targetId: id,
    summary: `已吊销 Agent Token「${existing.name}」`,
    details: { name: existing.name },
    ipAddress: requestIp(c.req.raw),
  });

  return c.json({ success: true });
});
