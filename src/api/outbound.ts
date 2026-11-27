import { Hono } from 'hono';
import { requestIp } from '../audit';
import {
  getEmailDeliveryConfig,
  getEmailSenderConfig,
  selectedSenderAddress,
} from '../settings';
import { sendComposedForPrincipal } from '../services/compose';
import { listKnownPrefixes, listSentEmailsForPrincipal } from '../services/mail-query';
import type { Env } from '../types';
import { latestReceivingAddress, mailDomainFromAddress } from './settings';

export const outboundRoutes = new Hono<{ Bindings: Env }>();

outboundRoutes.get('/context', async (c) => {
  const [senderConfig, deliveryConfig, latestToAddr, prefixes] = await Promise.all([
    getEmailSenderConfig(c.env.DB, c.env.EMAIL_FROM_ADDRESS),
    getEmailDeliveryConfig(c.env.DB),
    latestReceivingAddress(c.env.DB),
    listKnownPrefixes(c.env.DB),
  ]);

  const receiveDomain = mailDomainFromAddress(latestToAddr);
  const sendDomain = mailDomainFromAddress(selectedSenderAddress(senderConfig)) || receiveDomain;
  const configured = deliveryConfig.provider === 'resend'
    ? Boolean(deliveryConfig.resend_api_key)
    : Boolean(c.env.EMAIL);

  return c.json({
    configured,
    provider: deliveryConfig.provider,
    send_domain: sendDomain,
    receive_domain: receiveDomain,
    prefixes,
  });
});

// Console sent-history list, newest first, paged by id cursor (before_id).
outboundRoutes.get('/sent', async (c) => {
  const beforeIdRaw = c.req.query('before_id');
  const limitRaw = c.req.query('limit');
  const beforeId = beforeIdRaw ? Number.parseInt(beforeIdRaw, 10) : undefined;
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  if ((beforeId !== undefined && !(beforeId > 0)) || (limit !== undefined && !(limit > 0))) {
    return c.json({ error: '无效的分页参数' }, 400);
  }

  const result = await listSentEmailsForPrincipal(c.env.DB, { kind: 'admin' }, { beforeId, limit });
  // Admin principal always passes scope/prefix checks; keep the guard for type narrowing.
  if (!result.ok) return c.json({ error: result.message }, 403);

  // Resolve Agent token names in one query so the list can show who sent each email.
  // Revoked tokens keep their row, so names stay resolvable for old history.
  const tokenIds = [...new Set(result.emails
    .map((email) => email.agent_token_id)
    .filter((id): id is number => typeof id === 'number'))];
  const tokenNames = new Map<number, string>();
  if (tokenIds.length > 0) {
    const rows = await c.env.DB.prepare(
      `SELECT id, name FROM agent_tokens WHERE id IN (${tokenIds.map(() => '?').join(', ')})`,
    ).bind(...tokenIds).all<{ id: number; name: string }>();
    for (const row of rows.results ?? []) tokenNames.set(row.id, row.name);
  }

  return c.json({
    data: result.emails.map((email) => ({
      ...email,
      agent_token_id: email.agent_token_id ?? null,
      agent_token_name: email.agent_token_id ? tokenNames.get(email.agent_token_id) ?? null : null,
    })),
    has_more: result.has_more,
    next_before_id: result.next_before_id,
  });
});

outboundRoutes.post('/send', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ error: '无效的请求格式' }, 400);
  }

  const result = await sendComposedForPrincipal(
    c.env,
    { kind: 'admin' },
    {
      prefix: body.prefix,
      to: body.to,
      subject: body.subject,
      text: body.text,
      replyToEmailId: body.reply_to_email_id,
    },
    { ipAddress: requestIp(c.req.raw) },
  );

  if (!result.ok) {
    if (result.code === 'PROVIDER_ERROR') {
      return c.json({
        error: result.message,
        email: result.email,
        id: result.id ?? null,
        from: result.from ?? '',
        reply_to: result.reply_to ?? '',
        sent: result.sent ?? null,
      }, 502);
    }
    return c.json({ error: result.message }, result.httpStatus as 400 | 403 | 404 | 409 | 429);
  }

  return c.json({
    success: true,
    id: result.id,
    message_id: result.message_id,
    from: result.from,
    reply_to: result.reply_to,
    sent: result.sent,
  });
});
