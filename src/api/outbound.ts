import { Hono } from 'hono';
import { requestIp, safeRecordAuditLog } from '../audit';
import { errorDescription } from '../email/errors';
import { emailSendErrorPayload, validateEmailAddress } from '../email/forward';
import {
  buildComposedAddresses,
  normalizeSenderPrefix,
  resolveOutboundEmailProvider,
  sendComposedEmail,
  validateSenderPrefix,
} from '../email/outbound';
import { buildReplyHeaders, parseReplyMetadata } from '../email/reply';
import {
  getEmailDeliveryConfig,
  getEmailSenderConfig,
  selectedSenderAddress,
} from '../settings';
import type { EmailProvider, Env, SentEmailRecord } from '../types';
import { latestReceivingAddress, mailDomainFromAddress } from './settings';

export const outboundRoutes = new Hono<{ Bindings: Env }>();

const MAX_SUBJECT_LENGTH = 998;
const MAX_TEXT_BODY_BYTES = 100 * 1024;
const PREFIX_SUGGESTION_LIMIT = 100;

interface ReplyTargetRow {
  id: number;
  from_addr: string;
  to_addr: string;
  to_prefix: string;
  raw_body: string;
}

function normalizeReplyEmailId(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const num = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isSafeInteger(num) && num > 0 ? num : Number.NaN;
}

function sanitizeSubject(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function listKnownPrefixes(db: D1Database): Promise<string[]> {
  const rows = await db.prepare(`
    SELECT prefix FROM (
      SELECT lower(to_prefix) AS prefix, MAX(created_at) AS seen_at
      FROM emails
      WHERE to_prefix <> ''
      GROUP BY lower(to_prefix)
      UNION ALL
      SELECT lower(from_prefix) AS prefix, MAX(created_at) AS seen_at
      FROM sent_emails
      WHERE from_prefix <> ''
      GROUP BY lower(from_prefix)
      UNION ALL
      SELECT lower(prefix) AS prefix, MAX(created_at) AS seen_at
      FROM forward_rules
      WHERE prefix <> '*' AND prefix <> ''
      GROUP BY lower(prefix)
      UNION ALL
      SELECT lower(prefix) AS prefix, MAX(created_at) AS seen_at
      FROM tg_rules
      WHERE prefix <> '*' AND prefix <> ''
      GROUP BY lower(prefix)
      UNION ALL
      SELECT lower(prefix) AS prefix, MAX(created_at) AS seen_at
      FROM bark_rules
      WHERE prefix <> '*' AND prefix <> ''
      GROUP BY lower(prefix)
    )
    GROUP BY prefix
    ORDER BY MAX(seen_at) DESC, prefix ASC
    LIMIT ?
  `).bind(PREFIX_SUGGESTION_LIMIT).all<{ prefix: string }>();

  return (rows.results ?? [])
    .map((row) => normalizeSenderPrefix(row.prefix))
    .filter((prefix) => validateSenderPrefix(prefix) === null);
}

async function recordSentEmail(
  db: D1Database,
  input: Omit<SentEmailRecord, 'id'>,
): Promise<SentEmailRecord> {
  const result = await db.prepare(`
    INSERT INTO sent_emails
      (from_prefix, from_addr, to_addr, reply_to, subject, text_body,
       reply_to_email_id, provider, provider_message_id, status, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.from_prefix,
    input.from_addr,
    input.to_addr,
    input.reply_to,
    input.subject,
    input.text_body,
    input.reply_to_email_id,
    input.provider,
    input.provider_message_id,
    input.status,
    input.error,
    input.created_at,
  ).run();

  return {
    id: Number(result.meta.last_row_id),
    ...input,
  };
}

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

  const prefix = normalizeSenderPrefix(typeof body.prefix === 'string' ? body.prefix : '');
  const prefixError = validateSenderPrefix(prefix);
  if (prefixError) return c.json({ error: prefixError }, 400);

  const to = typeof body.to === 'string' ? body.to.trim() : '';
  const toError = validateEmailAddress(to);
  if (toError) return c.json({ error: toError }, 400);

  const subject = sanitizeSubject(body.subject);
  if (!subject) return c.json({ error: '请填写邮件主题' }, 400);
  if (subject.length > MAX_SUBJECT_LENGTH) {
    return c.json({ error: `邮件主题最多 ${MAX_SUBJECT_LENGTH} 个字符` }, 400);
  }

  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return c.json({ error: '请填写邮件正文' }, 400);
  if (utf8ByteLength(text) > MAX_TEXT_BODY_BYTES) {
    return c.json({ error: '邮件正文不能超过 100 KB' }, 400);
  }

  const replyToEmailId = normalizeReplyEmailId(body.reply_to_email_id);
  if (Number.isNaN(replyToEmailId)) {
    return c.json({ error: '无效的回复邮件 ID' }, 400);
  }

  let replyEmail: ReplyTargetRow | null = null;
  if (replyToEmailId !== null) {
    replyEmail = await c.env.DB.prepare(
      'SELECT id, from_addr, to_addr, to_prefix, raw_body FROM emails WHERE id = ?',
    ).bind(replyToEmailId).first<ReplyTargetRow>();
    if (!replyEmail) {
      return c.json({ error: '原邮件不存在' }, 404);
    }
  }

  let provider;
  try {
    provider = await resolveOutboundEmailProvider(c.env);
  } catch (error) {
    return c.json({ error: errorDescription(error, '邮件发送尚未配置') }, 400);
  }

  const [senderConfig, latestToAddr] = await Promise.all([
    getEmailSenderConfig(c.env.DB, c.env.EMAIL_FROM_ADDRESS),
    replyEmail ? Promise.resolve(replyEmail.to_addr) : latestReceivingAddress(c.env.DB),
  ]);
  const receiveDomain = mailDomainFromAddress(replyEmail ? replyEmail.to_addr : latestToAddr);
  const sendDomain = mailDomainFromAddress(selectedSenderAddress(senderConfig)) || receiveDomain;
  if (!sendDomain) {
    return c.json({ error: '无法确定发件域名，请先在「设置 → 邮件发送」中配置发件地址' }, 400);
  }

  const { from, replyTo } = buildComposedAddresses(prefix, sendDomain, receiveDomain);
  let headers: Record<string, string> | undefined;
  if (replyEmail) {
    const replyMeta = await parseReplyMetadata(replyEmail.raw_body, replyEmail.from_addr);
    headers = buildReplyHeaders(replyMeta);
  }

  const createdAt = new Date().toISOString();
  const action = replyEmail ? 'email.reply' : 'email.send';

  try {
    const result = await sendComposedEmail(provider, {
      prefix,
      sendDomain,
      receiveDomain,
      to,
      subject,
      text,
      headers,
    });
    const sent = await recordSentEmail(c.env.DB, {
      from_prefix: prefix,
      from_addr: result.from,
      to_addr: to,
      reply_to: result.replyTo,
      subject,
      text_body: text,
      reply_to_email_id: replyEmail?.id ?? null,
      provider: provider.name as EmailProvider,
      provider_message_id: result.messageId,
      status: 'success',
      error: '',
      created_at: createdAt,
    });
    await safeRecordAuditLog(c.env.DB, {
      category: 'email',
      action,
      status: 'success',
      actor: 'admin',
      targetType: 'sent_email',
      targetId: sent.id,
      summary: `已从 ${result.from} 发送邮件至 ${to}`,
      details: {
        sent_email_id: sent.id,
        from: result.from,
        reply_to: result.replyTo,
        to,
        subject,
        provider: provider.name,
        provider_message_id: result.messageId,
        reply_to_email_id: replyEmail?.id ?? null,
      },
      ipAddress: requestIp(c.req.raw),
    });
    return c.json({
      success: true,
      id: sent.id,
      message_id: result.messageId,
      from: result.from,
      reply_to: result.replyTo,
      sent,
    });
  } catch (error) {
    const payload = emailSendErrorPayload(error);
    const description = payload.email.description;
    let sent: SentEmailRecord | null = null;
    try {
      sent = await recordSentEmail(c.env.DB, {
        from_prefix: prefix,
        from_addr: from,
        to_addr: to,
        reply_to: replyTo ?? '',
        subject,
        text_body: text,
        reply_to_email_id: replyEmail?.id ?? null,
        provider: provider.name as EmailProvider,
        provider_message_id: '',
        status: 'failed',
        error: description,
        created_at: createdAt,
      });
    } catch (recordError) {
      console.error(JSON.stringify({
        message: 'failed sent_email persistence failed',
        error: errorDescription(recordError, 'Unknown DB error'),
      }));
    }
    await safeRecordAuditLog(c.env.DB, {
      category: 'email',
      action,
      status: 'failed',
      actor: 'admin',
      targetType: 'sent_email',
      targetId: sent?.id ?? '',
      summary: `从 ${from} 发送邮件至 ${to} 失败：${description}`,
      details: {
        sent_email_id: sent?.id ?? null,
        from,
        reply_to: replyTo ?? '',
        to,
        subject,
        provider: provider.name,
        reply_to_email_id: replyEmail?.id ?? null,
        error: description,
      },
      ipAddress: requestIp(c.req.raw),
    });
    return c.json({
      error: '邮件发送失败',
      email: payload.email,
      id: sent?.id ?? null,
      from,
      reply_to: replyTo ?? '',
      sent,
    }, 502);
  }
});
