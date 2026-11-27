import { safeRecordAuditLog } from '../audit';
import {
  canReadPrefix,
  canSendFromPrefix,
  canSendToRecipient,
  hasScope,
  type Principal,
} from '../auth/principal';
import { errorDescription } from '../email/errors';
import { emailSendErrorPayload, validateEmailAddress } from '../email/forward';
import {
  buildComposedAddresses,
  normalizeSenderPrefix,
  resolveOutboundEmailProvider,
  sendComposedEmail,
  validateSenderPrefix,
} from '../email/outbound';
import { buildReplyHeaders, parseReplyMetadata, replySubject } from '../email/reply';
import {
  getEmailSenderConfig,
  selectedSenderAddress,
} from '../settings';
import { latestReceivingAddress, mailDomainFromAddress } from '../api/settings';
import type { EmailProvider, Env, SentEmailRecord } from '../types';
import { getSendQuotaSnapshot } from './mail-query';

const MAX_SUBJECT_LENGTH = 998;
const MAX_TEXT_BODY_BYTES = 100 * 1024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const encoder = new TextEncoder();

interface ReplyTargetRow {
  id: number;
  from_addr: string;
  to_addr: string;
  to_prefix: string;
  subject: string;
  raw_body: string;
}

export interface ComposeAuditContext {
  ipAddress: string;
}

export interface SendComposedInput {
  prefix: unknown;
  to: unknown;
  subject: unknown;
  text: unknown;
  replyToEmailId?: unknown;
  idempotencyKey?: unknown;
}

export interface ReplyEmailInput {
  emailId: number;
  text: unknown;
  subject?: unknown;
  fromPrefix?: unknown;
  idempotencyKey?: unknown;
}

export type ComposeErrorCode =
  | 'INVALID_INPUT'
  | 'FORBIDDEN_SCOPE'
  | 'FORBIDDEN_PREFIX'
  | 'FORBIDDEN_RECIPIENT'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'NOT_CONFIGURED'
  | 'PROVIDER_ERROR';

export type ComposeResult =
  | {
    ok: true;
    replayed: boolean;
    id: number;
    message_id: string;
    from: string;
    reply_to: string;
    sent: SentEmailRecord;
  }
  | {
    ok: false;
    code: ComposeErrorCode;
    httpStatus: number;
    message: string;
    email?: ReturnType<typeof emailSendErrorPayload>['email'];
    id?: number | null;
    from?: string;
    reply_to?: string;
    sent?: SentEmailRecord | null;
  };

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
  return encoder.encode(value).byteLength;
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function recordSentEmail(
  db: D1Database,
  input: Omit<SentEmailRecord, 'id'> & {
    agent_token_id: number | null;
    idempotency_key: string | null;
    idempotency_hash: string;
  },
): Promise<SentEmailRecord> {
  const result = await db.prepare(`
    INSERT INTO sent_emails
      (from_prefix, from_addr, to_addr, reply_to, subject, text_body,
       reply_to_email_id, provider, provider_message_id, status, error, created_at,
       agent_token_id, idempotency_key, idempotency_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    input.agent_token_id,
    input.idempotency_key,
    input.idempotency_hash,
  ).run();

  return {
    id: Number(result.meta.last_row_id),
    from_prefix: input.from_prefix,
    from_addr: input.from_addr,
    to_addr: input.to_addr,
    reply_to: input.reply_to,
    subject: input.subject,
    text_body: input.text_body,
    reply_to_email_id: input.reply_to_email_id,
    provider: input.provider,
    provider_message_id: input.provider_message_id,
    status: input.status,
    error: input.error,
    created_at: input.created_at,
    ...(input.agent_token_id !== null ? { agent_token_id: input.agent_token_id } : {}),
    ...(input.idempotency_key !== null ? { idempotency_key: input.idempotency_key } : {}),
  };
}

export async function sendComposedForPrincipal(
  env: Env,
  principal: Principal,
  input: SendComposedInput,
  auditCtx: ComposeAuditContext,
): Promise<ComposeResult> {
  if (!hasScope(principal, 'mail:send')) {
    return {
      ok: false,
      code: 'FORBIDDEN_SCOPE',
      httpStatus: 403,
      message: '当前 Token 没有发信（mail:send）权限',
    };
  }

  const prefix = normalizeSenderPrefix(typeof input.prefix === 'string' ? input.prefix : '');
  const prefixError = validateSenderPrefix(prefix);
  if (prefixError) {
    return { ok: false, code: 'INVALID_INPUT', httpStatus: 400, message: prefixError };
  }

  const to = typeof input.to === 'string' ? input.to.trim() : '';
  const toError = validateEmailAddress(to);
  if (toError) {
    return { ok: false, code: 'INVALID_INPUT', httpStatus: 400, message: toError };
  }

  const subject = sanitizeSubject(input.subject);
  if (!subject) {
    return { ok: false, code: 'INVALID_INPUT', httpStatus: 400, message: '请填写邮件主题' };
  }
  if (subject.length > MAX_SUBJECT_LENGTH) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      httpStatus: 400,
      message: `邮件主题最多 ${MAX_SUBJECT_LENGTH} 个字符`,
    };
  }

  const text = typeof input.text === 'string' ? input.text : '';
  if (!text.trim()) {
    return { ok: false, code: 'INVALID_INPUT', httpStatus: 400, message: '请填写邮件正文' };
  }
  if (utf8ByteLength(text) > MAX_TEXT_BODY_BYTES) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      httpStatus: 400,
      message: '邮件正文不能超过 100 KB',
    };
  }

  const replyToEmailId = normalizeReplyEmailId(input.replyToEmailId);
  if (Number.isNaN(replyToEmailId)) {
    return { ok: false, code: 'INVALID_INPUT', httpStatus: 400, message: '无效的回复邮件 ID' };
  }

  let idempotencyKey: string | null = null;
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null && input.idempotencyKey !== '') {
    if (typeof input.idempotencyKey !== 'string') {
      return { ok: false, code: 'INVALID_INPUT', httpStatus: 400, message: 'idempotency_key 必须是字符串' };
    }
    const trimmedKey = input.idempotencyKey.trim();
    if (!trimmedKey || trimmedKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        httpStatus: 400,
        message: `idempotency_key 长度需在 1–${MAX_IDEMPOTENCY_KEY_LENGTH} 个字符之间`,
      };
    }
    idempotencyKey = trimmedKey;
  }

  if (principal.kind === 'agent') {
    if (!canSendFromPrefix(principal, prefix)) {
      return {
        ok: false,
        code: 'FORBIDDEN_PREFIX',
        httpStatus: 403,
        message: `当前 Token 不允许使用发件前缀「${prefix}」（发信需精确匹配已授权前缀）`,
      };
    }
    if (!canSendToRecipient(principal, to)) {
      return {
        ok: false,
        code: 'FORBIDDEN_RECIPIENT',
        httpStatus: 403,
        message: `收件人「${to}」不在当前 Token 的收件人白名单中`,
      };
    }
  }

  let replyEmail: ReplyTargetRow | null = null;
  if (replyToEmailId !== null) {
    replyEmail = await env.DB.prepare(
      'SELECT id, from_addr, to_addr, to_prefix, subject, raw_body FROM emails WHERE id = ?',
    ).bind(replyToEmailId).first<ReplyTargetRow>();
    if (!replyEmail) {
      return { ok: false, code: 'NOT_FOUND', httpStatus: 404, message: '原邮件不存在' };
    }
    if (principal.kind === 'agent' && !canReadPrefix(principal, replyEmail.to_prefix)) {
      return {
        ok: false,
        code: 'FORBIDDEN_PREFIX',
        httpStatus: 403,
        message: `原邮件 #${replyToEmailId} 不在当前 Token 的允许前缀范围内`,
      };
    }
  }

  let idempotencyHash = '';
  if (principal.kind === 'agent' && idempotencyKey) {
    idempotencyHash = await sha256Base64Url(JSON.stringify([
      prefix,
      to.toLowerCase(),
      subject,
      text,
      replyToEmailId ?? null,
    ]));
    const existing = await env.DB.prepare(`
      SELECT
        id, from_prefix, from_addr, to_addr, reply_to, subject, text_body,
        reply_to_email_id, provider, provider_message_id, status, error, created_at,
        agent_token_id, idempotency_key, idempotency_hash
      FROM sent_emails
      WHERE agent_token_id = ? AND idempotency_key = ? AND status = 'success'
      LIMIT 1
    `).bind(principal.tokenId, idempotencyKey).first<SentEmailRecord & { idempotency_hash?: string }>();

    if (existing) {
      if (existing.idempotency_hash && existing.idempotency_hash !== idempotencyHash) {
        return {
          ok: false,
          code: 'IDEMPOTENCY_CONFLICT',
          httpStatus: 409,
          message: `幂等键「${idempotencyKey}」已被用于发送不同的邮件内容，请更换新的 idempotency_key`,
        };
      }
      const { idempotency_hash: _ignored, ...sent } = existing;
      return {
        ok: true,
        replayed: true,
        id: sent.id,
        message_id: sent.provider_message_id,
        from: sent.from_addr,
        reply_to: sent.reply_to,
        sent,
      };
    }
  }

  if (principal.kind === 'agent') {
    const quota = await getSendQuotaSnapshot(env.DB, principal);
    if (quota.instance_day_limit <= 0 || quota.instance_day_used >= quota.instance_day_limit) {
      return {
        ok: false,
        code: 'RATE_LIMITED',
        httpStatus: 429,
        message: `实例级 Agent 每日发信额度已用尽（${quota.instance_day_used}/${quota.instance_day_limit}），请稍后再试或在控制台调整上限`,
      };
    }
    if ((quota.token_hour_used ?? 0) >= principal.sendLimitHour) {
      return {
        ok: false,
        code: 'RATE_LIMITED',
        httpStatus: 429,
        message: `当前 Token 每小时发信上限已用尽（${quota.token_hour_used}/${principal.sendLimitHour}）`,
      };
    }
    if ((quota.token_day_used ?? 0) >= principal.sendLimitDay) {
      return {
        ok: false,
        code: 'RATE_LIMITED',
        httpStatus: 429,
        message: `当前 Token 每日发信上限已用尽（${quota.token_day_used}/${principal.sendLimitDay}）`,
      };
    }
  }

  let provider;
  try {
    provider = await resolveOutboundEmailProvider(env);
  } catch (error) {
    return {
      ok: false,
      code: 'NOT_CONFIGURED',
      httpStatus: 400,
      message: errorDescription(error, '邮件发送尚未配置'),
    };
  }

  const [senderConfig, latestToAddr] = await Promise.all([
    getEmailSenderConfig(env.DB, env.EMAIL_FROM_ADDRESS),
    replyEmail ? Promise.resolve(replyEmail.to_addr) : latestReceivingAddress(env.DB),
  ]);
  const receiveDomain = mailDomainFromAddress(replyEmail ? replyEmail.to_addr : latestToAddr);
  const sendDomain = mailDomainFromAddress(selectedSenderAddress(senderConfig)) || receiveDomain;
  if (!sendDomain) {
    return {
      ok: false,
      code: 'NOT_CONFIGURED',
      httpStatus: 400,
      message: '无法确定发件域名，请先在「设置 → 邮件发送」中配置发件地址',
    };
  }

  const { from, replyTo } = buildComposedAddresses(prefix, sendDomain, receiveDomain);
  let headers: Record<string, string> | undefined;
  if (replyEmail) {
    const replyMeta = await parseReplyMetadata(replyEmail.raw_body, replyEmail.from_addr);
    headers = buildReplyHeaders(replyMeta);
  }

  const createdAt = new Date().toISOString();
  const action = replyEmail ? 'email.reply' : 'email.send';
  const actor = principal.kind === 'agent' ? 'agent' : 'admin';
  const actorId = principal.kind === 'agent' ? principal.tokenId : '';
  const agentDetails = principal.kind === 'agent'
    ? {
      agent_token_id: principal.tokenId,
      agent_token_name: principal.name,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    }
    : {};

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
    const sent = await recordSentEmail(env.DB, {
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
      agent_token_id: principal.kind === 'agent' ? principal.tokenId : null,
      idempotency_key: idempotencyKey,
      idempotency_hash: idempotencyHash,
    });
    await safeRecordAuditLog(env.DB, {
      category: 'email',
      action,
      status: 'success',
      actor,
      actorId,
      targetType: 'sent_email',
      targetId: sent.id,
      summary: principal.kind === 'agent'
        ? `Agent「${principal.name}」已从 ${result.from} 发送邮件至 ${to}`
        : `已从 ${result.from} 发送邮件至 ${to}`,
      details: {
        sent_email_id: sent.id,
        from: result.from,
        reply_to: result.replyTo,
        to,
        subject,
        provider: provider.name,
        provider_message_id: result.messageId,
        reply_to_email_id: replyEmail?.id ?? null,
        ...agentDetails,
      },
      ipAddress: auditCtx.ipAddress,
    });
    return {
      ok: true,
      replayed: false,
      id: sent.id,
      message_id: result.messageId,
      from: result.from,
      reply_to: result.replyTo,
      sent,
    };
  } catch (error) {
    const payload = emailSendErrorPayload(error);
    const description = payload.email.description;
    let sent: SentEmailRecord | null = null;
    try {
      sent = await recordSentEmail(env.DB, {
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
        agent_token_id: principal.kind === 'agent' ? principal.tokenId : null,
        idempotency_key: idempotencyKey,
        idempotency_hash: idempotencyHash,
      });
    } catch (recordError) {
      console.error(JSON.stringify({
        message: 'failed sent_email persistence failed',
        error: errorDescription(recordError, 'Unknown DB error'),
      }));
    }
    await safeRecordAuditLog(env.DB, {
      category: 'email',
      action,
      status: 'failed',
      actor,
      actorId,
      targetType: 'sent_email',
      targetId: sent?.id ?? '',
      summary: principal.kind === 'agent'
        ? `Agent「${principal.name}」从 ${from} 发送邮件至 ${to} 失败：${description}`
        : `从 ${from} 发送邮件至 ${to} 失败：${description}`,
      details: {
        sent_email_id: sent?.id ?? null,
        from,
        reply_to: replyTo ?? '',
        to,
        subject,
        provider: provider.name,
        reply_to_email_id: replyEmail?.id ?? null,
        error: description,
        ...agentDetails,
      },
      ipAddress: auditCtx.ipAddress,
    });
    return {
      ok: false,
      code: 'PROVIDER_ERROR',
      httpStatus: 502,
      message: '邮件发送失败',
      email: payload.email,
      id: sent?.id ?? null,
      from,
      reply_to: replyTo ?? '',
      sent,
    };
  }
}

export async function replyToEmailForPrincipal(
  env: Env,
  principal: Principal,
  input: ReplyEmailInput,
  auditCtx: ComposeAuditContext,
): Promise<ComposeResult> {
  if (!hasScope(principal, 'mail:send')) {
    return {
      ok: false,
      code: 'FORBIDDEN_SCOPE',
      httpStatus: 403,
      message: '当前 Token 没有发信（mail:send）权限',
    };
  }

  const original = await env.DB.prepare(
    'SELECT id, from_addr, to_addr, to_prefix, subject, raw_body FROM emails WHERE id = ?',
  ).bind(input.emailId).first<ReplyTargetRow>();

  if (!original) {
    return { ok: false, code: 'NOT_FOUND', httpStatus: 404, message: `原邮件 #${input.emailId} 不存在` };
  }
  if (principal.kind === 'agent' && !canReadPrefix(principal, original.to_prefix)) {
    return {
      ok: false,
      code: 'FORBIDDEN_PREFIX',
      httpStatus: 403,
      message: `原邮件 #${input.emailId} 不在当前 Token 的允许前缀范围内`,
    };
  }

  const replyMeta = await parseReplyMetadata(original.raw_body, original.from_addr);
  if (!replyMeta.replyAddress) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      httpStatus: 400,
      message: '无法从原邮件解析有效的回复地址',
    };
  }

  // Derive sender prefix from the original recipient prefix; strip +tag subaddress if needed
  // because outbound sending only permits exact authorized prefixes.
  let derivedPrefix = normalizeSenderPrefix(
    typeof input.fromPrefix === 'string' && input.fromPrefix.trim()
      ? input.fromPrefix
      : original.to_prefix,
  );
  if (
    principal.kind === 'agent'
    && !canSendFromPrefix(principal, derivedPrefix)
    && derivedPrefix.includes('+')
  ) {
    const basePrefix = derivedPrefix.slice(0, derivedPrefix.indexOf('+'));
    if (canSendFromPrefix(principal, basePrefix)) {
      derivedPrefix = basePrefix;
    }
  }

  const finalSubject = typeof input.subject === 'string' && input.subject.trim()
    ? input.subject
    : replySubject(original.subject);

  return sendComposedForPrincipal(
    env,
    principal,
    {
      prefix: derivedPrefix,
      to: replyMeta.replyAddress,
      subject: finalSubject,
      text: input.text,
      replyToEmailId: original.id,
      idempotencyKey: input.idempotencyKey,
    },
    auditCtx,
  );
}
