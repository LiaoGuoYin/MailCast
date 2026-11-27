import { Hono } from 'hono';
import { requestIp } from '../audit';
import {
  getEmailDeliveryConfig,
  getEmailSenderConfig,
  selectedSenderAddress,
} from '../settings';
import { sendComposedForPrincipal } from '../services/compose';
import { listKnownPrefixes } from '../services/mail-query';
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
