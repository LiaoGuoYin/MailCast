import { extractCodeWithAI } from '../ai/extract';
import { getAiConfig } from '../settings';
import { sendTgNotification, TelegramApiError } from '../telegram/notify';
import { resolveTelegramDeliveryBot } from '../telegram/bots';
import type {
  DownstreamChannel,
  DownstreamSource,
  EmailDownstream,
  Env,
} from '../types';
import { buildForwardedEmail, validateEmailAddress } from './forward';
import { getBarkEndpoint } from '../bark/endpoints';
import { BarkApiError, buildBarkEmailBody, sendBarkPush } from '../bark/notify';

const MAX_ERROR_LENGTH = 1000;

export interface DeliveryEmail {
  id: number;
  from_addr: string;
  to_addr: string;
  subject: string;
  text_body: string;
  html_body: string;
  body_truncated: boolean;
  created_at: string;
}

export interface DownstreamErrorDetails {
  code: string;
  description: string;
}

export function downstreamErrorDetails(error: unknown): DownstreamErrorDetails {
  if (error instanceof TelegramApiError) {
    return {
      code: error.errorCode === null ? 'TELEGRAM_ERROR' : `TELEGRAM_${error.errorCode}`,
      description: error.description.slice(0, MAX_ERROR_LENGTH),
    };
  }
  if (error instanceof BarkApiError) {
    return {
      code: error.errorCode === null ? 'BARK_ERROR' : `BARK_${error.errorCode}`,
      description: error.description.slice(0, MAX_ERROR_LENGTH),
    };
  }

  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  const name = error && typeof error === 'object' ? Reflect.get(error, 'name') : undefined;
  const description = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : 'Unknown downstream error';

  return {
    code: String(code ?? name ?? 'DOWNSTREAM_ERROR').slice(0, 100),
    description: description.slice(0, MAX_ERROR_LENGTH),
  };
}

export async function createDownstream(
  db: D1Database,
  input: {
    emailId: number;
    channel: DownstreamChannel;
    source: DownstreamSource;
    ruleId?: number | null;
    target: string;
    telegramBotId?: number | null;
    telegramBotName?: string;
    barkEndpointId?: number | null;
    barkEndpointName?: string;
  },
): Promise<number> {
  const now = new Date().toISOString();
  const result = await db.prepare(`
    INSERT INTO email_downstreams
      (email_id, channel, source, rule_id, target, telegram_bot_id, telegram_bot_name,
       bark_endpoint_id, bark_endpoint_name,
       status, attempt_count,
       last_error, last_triggered_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, '', ?, ?, ?)
  `).bind(
    input.emailId,
    input.channel,
    input.source,
    input.ruleId ?? null,
    input.target,
    input.telegramBotId ?? null,
    input.telegramBotName ?? '',
    input.barkEndpointId ?? null,
    input.barkEndpointName ?? '',
    now,
    now,
    now,
  ).run();

  return result.meta.last_row_id;
}

export async function settleDownstream(
  db: D1Database,
  downstreamId: number,
  attemptCount: number,
  error: unknown | null,
): Promise<boolean> {
  const details = error === null ? null : downstreamErrorDetails(error);
  const result = await db.prepare(`
    UPDATE email_downstreams
    SET status = ?, last_error = ?, updated_at = ?
    WHERE id = ? AND attempt_count = ?
  `).bind(
    details ? 'failed' : 'success',
    details?.description ?? '',
    new Date().toISOString(),
    downstreamId,
    attemptCount,
  ).run();

  // A stale attempt may finish after a newer retry has already claimed the
  // same row. In that case it must not overwrite the newer attempt's state.
  return result.meta.changes === 1;
}

export async function claimDownstreamRetry(
  db: D1Database,
  emailId: number,
  downstreamId: number,
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db.prepare(`
    UPDATE email_downstreams
    SET status = 'pending', attempt_count = attempt_count + 1,
        last_error = '', last_triggered_at = ?, updated_at = ?
    WHERE id = ? AND email_id = ?
      AND (
        status <> 'pending'
        OR julianday(last_triggered_at) < julianday('now', '-2 minutes')
      )
  `).bind(now, now, downstreamId, emailId).run();

  return result.meta.changes === 1;
}

export async function deliverStoredDownstream(
  env: Env,
  email: DeliveryEmail,
  downstream: Pick<EmailDownstream, 'channel' | 'target'> & {
    telegram_bot_id?: number | null;
    bark_endpoint_id?: number | null;
  },
): Promise<string | null> {
  if (downstream.channel === 'forward') {
    const problem = validateEmailAddress(downstream.target);
    if (problem) throw new Error(problem);

    const forwarded = buildForwardedEmail(email);
    const replyTo = validateEmailAddress(email.from_addr) === null
      ? email.from_addr
      : undefined;
    const result = await env.EMAIL.send({
      from: { email: env.EMAIL_FROM_ADDRESS, name: 'MailCast' },
      to: downstream.target,
      ...(replyTo ? { replyTo } : {}),
      subject: forwarded.subject,
      text: forwarded.text,
      html: forwarded.html,
    });
    return result.messageId;
  }

  const analysisBody = email.text_body || email.html_body;
  let code: string | null = null;
  try {
    const aiConfig = await getAiConfig(env.DB);
    code = await extractCodeWithAI(env, aiConfig, email.subject, analysisBody);
  } catch (error) {
    const details = downstreamErrorDetails(error);
    console.error(JSON.stringify({
      message: `verification code extraction failed before manual ${downstream.channel} retry`,
      email_id: email.id,
      code: details.code,
      error: details.description,
    }));
  }
  if (downstream.channel === 'telegram') {
    const bot = await resolveTelegramDeliveryBot(env, downstream.telegram_bot_id);
    await sendTgNotification(bot.token, downstream.target, {
      from: email.from_addr,
      to: email.to_addr,
      subject: email.subject,
      body: analysisBody,
      code,
    });
  } else {
    if (!downstream.bark_endpoint_id) throw new Error('Bark 推送未绑定有效目标，请重新配置规则');
    const endpoint = await getBarkEndpoint(env.DB, downstream.bark_endpoint_id);
    if (!endpoint) throw new Error('Bark 目标不存在或已删除');
    await sendBarkPush(endpoint.server_url, endpoint.device_key, {
      title: email.subject || '新邮件',
      body: buildBarkEmailBody({
        from: email.from_addr,
        to: email.to_addr,
        body: analysisBody,
        code,
      }),
    });
  }
  return null;
}
