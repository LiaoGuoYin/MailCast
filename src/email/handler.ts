import { parseEmail } from './parser';
import { sendTgNotification } from '../telegram/notify';
import { extractCodeWithAI } from '../ai/extract';
import { getAiConfig, getEmailSenderAddress } from '../settings';
import type { Env, ForwardRule, TgRule } from '../types';
import {
  createDownstream,
  downstreamErrorDetails,
  settleDownstream,
} from './downstream';
import { safeRecordAuditLog } from '../audit';
import type { BarkRule } from '../types';
import { buildBarkEmailBody, sendBarkPush } from '../bark/notify';
import {
  type OutboundEmailProvider,
  resolveOutboundEmailProvider,
  sendForwardedEmail,
} from './outbound';

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const parsed = await parseEmail(message);
  const receivedAt = new Date().toISOString();

  // Store in D1
  const stored = await env.DB.prepare(
    `INSERT INTO emails
      (from_addr, to_addr, to_prefix, subject, text_body, html_body, body_truncated,
       raw_body, raw_truncated, downstream_recorded, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(
      parsed.from_addr,
      parsed.to_addr,
      parsed.to_prefix,
      parsed.subject,
      parsed.text_body,
      parsed.html_body,
      parsed.body_truncated,
      parsed.raw_body,
      parsed.raw_truncated,
      receivedAt,
    )
    .run();
  const emailId = stored.meta.last_row_id;

  const [forwardRules, tgRules, barkRules] = await Promise.all([
    env.DB.prepare(
      `SELECT r.id, r.prefix, r.destination_id, r.enabled, r.created_at,
              d.name AS destination_name, d.email_address AS target_email
       FROM forward_rules r
       JOIN email_destinations d ON d.id = r.destination_id
       WHERE (r.prefix = ? OR r.prefix = ?) AND r.enabled = 1`,
    ).bind(parsed.to_prefix, '*').all<ForwardRule>(),
    env.DB.prepare(
      `SELECT
         r.id, r.prefix, r.chat_id, r.bot_id, r.enabled, r.created_at,
         COALESCE(b.name, '') AS bot_name,
         COALESCE(b.token, '') AS bot_token
       FROM tg_rules r
       LEFT JOIN telegram_bots b ON b.id = r.bot_id
       WHERE (r.prefix = ? OR r.prefix = ?) AND r.enabled = 1`,
    ).bind(parsed.to_prefix, '*').all<TgDeliveryRule>(),
    env.DB.prepare(
      `SELECT r.id, r.prefix, r.endpoint_id, r.enabled, r.created_at,
              e.name AS endpoint_name, e.server_url, e.device_key
       FROM bark_rules r
       JOIN bark_endpoints e ON e.id = r.endpoint_id
       WHERE (r.prefix = ? OR r.prefix = ?) AND r.enabled = 1`,
    ).bind(parsed.to_prefix, '*').all<BarkDeliveryRule>(),
  ]);
  await env.DB.prepare(
    'UPDATE emails SET downstream_recorded = 1 WHERE id = ?',
  ).bind(emailId).run();

  let emailFromAddress = '';
  let emailProvider: OutboundEmailProvider | null = null;
  let emailSenderError: unknown | null = null;
  if (forwardRules.results.length > 0) {
    try {
      [emailProvider, emailFromAddress] = await Promise.all([
        resolveOutboundEmailProvider(env),
        getEmailSenderAddress(env.DB, env.EMAIL_FROM_ADDRESS, parsed.to_addr),
      ]);
    } catch (error) {
      emailSenderError = error;
    }
  }

  for (const rule of forwardRules.results) {
    const downstreamId = await recordPendingDownstream(env, {
      emailId,
      channel: 'forward',
      ruleId: rule.id,
      target: rule.target_email,
    });
    let deliveryError: unknown | null = null;
    try {
      if (emailSenderError) throw emailSenderError;
      if (!emailProvider) throw new Error('邮件发送服务初始化失败');
      await sendForwardedEmail(
        emailProvider,
        emailFromAddress,
        {
          id: Number(emailId),
          ...parsed,
          body_truncated: Boolean(parsed.body_truncated),
          created_at: receivedAt,
        },
        rule.target_email,
      );
    } catch (error) {
      deliveryError = error;
      const details = downstreamErrorDetails(error);
      console.error(JSON.stringify({
        message: 'automatic email forward failed',
        email_id: emailId,
        rule_id: rule.id,
        target_domain: rule.target_email.split('@')[1] || '',
        code: details.code,
        error: details.description,
      }));
    }
    await recordDownstreamOutcome(env, emailId, downstreamId, 1, deliveryError, {
      channel: 'forward', target: rule.target_email, ruleId: rule.id,
    });
  }

  if (tgRules.results.length > 0) {
    const trackedRules = await Promise.all(tgRules.results.map(async (rule) => ({
      rule,
      downstreamId: await recordPendingDownstream(env, {
        emailId,
        channel: 'telegram',
        ruleId: rule.id,
        target: rule.chat_id,
        telegramBotId: rule.bot_id,
        telegramBotName: rule.bot_name,
      }),
    })));
    ctx.waitUntil(notifyTelegram(env, emailId, parsed, trackedRules));
  }

  if (barkRules.results.length > 0) {
    const trackedRules = await Promise.all(barkRules.results.map(async (rule) => ({
      rule,
      downstreamId: await recordPendingDownstream(env, {
        emailId,
        channel: 'bark',
        ruleId: rule.id,
        target: rule.endpoint_name,
        barkEndpointId: rule.endpoint_id,
        barkEndpointName: rule.endpoint_name,
      }),
    })));
    ctx.waitUntil(notifyBark(env, emailId, parsed, trackedRules));
  }
}

async function recordPendingDownstream(
  env: Env,
  input: {
    emailId: number;
    channel: 'forward' | 'telegram' | 'bark';
    ruleId: number;
    target: string;
    telegramBotId?: number | null;
    telegramBotName?: string;
    barkEndpointId?: number | null;
    barkEndpointName?: string;
  },
): Promise<number | null> {
  try {
    return await createDownstream(env.DB, {
      ...input,
      source: 'rule',
    });
  } catch (error) {
    const details = downstreamErrorDetails(error);
    console.error(JSON.stringify({
      message: 'downstream record creation failed',
      email_id: input.emailId,
      channel: input.channel,
      rule_id: input.ruleId,
      code: details.code,
      error: details.description,
    }));
    await env.DB.prepare(
      'UPDATE emails SET downstream_recorded = 0 WHERE id = ?',
    ).bind(input.emailId).run().catch(() => undefined);
    return null;
  }
}

async function recordDownstreamOutcome(
  env: Env,
  emailId: number,
  downstreamId: number | null,
  attemptCount: number,
  error: unknown | null,
  destination: {
    channel: 'forward' | 'telegram' | 'bark';
    target: string;
    ruleId: number;
    botId?: number | null;
    botName?: string;
  },
): Promise<void> {
  if (downstreamId === null) return;
  try {
    await settleDownstream(env.DB, downstreamId, attemptCount, error);
  } catch (settleError) {
    const details = downstreamErrorDetails(settleError);
    console.error(JSON.stringify({
      message: 'downstream result update failed',
      email_id: emailId,
      downstream_id: downstreamId,
      code: details.code,
      error: details.description,
    }));
  }

  const errorDetails = error === null ? null : downstreamErrorDetails(error);
  const channelName = destination.channel === 'forward'
    ? '邮件转发'
    : destination.channel === 'telegram' ? 'Telegram 推送' : 'Bark 推送';
  await safeRecordAuditLog(env.DB, {
    category: 'delivery',
    action: `delivery.${destination.channel}.automatic`,
    status: errorDetails ? 'failed' : 'success',
    actor: 'system',
    targetType: 'email_downstream',
    targetId: downstreamId,
    summary: `自动${channelName}${errorDetails ? '失败' : '成功'}：${destination.target}`,
    details: {
      email_id: emailId,
      downstream_id: downstreamId,
      rule_id: destination.ruleId,
      channel: destination.channel,
      target: destination.target,
      attempt: attemptCount,
      bot_id: destination.botId ?? null,
      bot_name: destination.botName ?? '',
      ...(errorDetails ? { error: errorDetails.description } : {}),
    },
  });
}

async function notifyBark(
  env: Env,
  emailId: number,
  parsed: Awaited<ReturnType<typeof parseEmail>>,
  trackedRules: Array<{ rule: BarkDeliveryRule; downstreamId: number | null }>,
): Promise<void> {
  const analysisBody = parsed.text_body || parsed.html_body;
  let code: string | null = null;
  try {
    code = await extractCodeWithAI(env, await getAiConfig(env.DB), parsed.subject, analysisBody);
  } catch (error) {
    console.error(JSON.stringify({
      message: 'verification code extraction failed before Bark push',
      email_id: emailId,
      error: downstreamErrorDetails(error).description,
    }));
  }

  await Promise.all(trackedRules.map(async ({ rule, downstreamId }) => {
    let deliveryError: unknown | null = null;
    try {
      await sendBarkPush(rule.server_url, rule.device_key, {
        title: parsed.subject || '新邮件',
        body: buildBarkEmailBody({
          from: parsed.from_addr,
          to: parsed.to_addr,
          body: analysisBody,
          code,
        }),
      });
    } catch (error) {
      deliveryError = error;
      console.error(JSON.stringify({
        message: 'automatic Bark push failed',
        email_id: emailId,
        rule_id: rule.id,
        error: downstreamErrorDetails(error).description,
      }));
    }
    await recordDownstreamOutcome(env, emailId, downstreamId, 1, deliveryError, {
      channel: 'bark', target: rule.endpoint_name, ruleId: rule.id,
    });
  }));
}

async function notifyTelegram(
  env: Env,
  emailId: number,
  parsed: Awaited<ReturnType<typeof parseEmail>>,
  trackedRules: Array<{ rule: TgDeliveryRule; downstreamId: number | null }>,
): Promise<void> {
  const analysisBody = parsed.text_body || parsed.html_body;
  let code: string | null = null;
  try {
    const aiConfig = await getAiConfig(env.DB);
    code = await extractCodeWithAI(env, aiConfig, parsed.subject, analysisBody);
  } catch (error) {
    const details = downstreamErrorDetails(error);
    console.error(JSON.stringify({
      message: 'verification code extraction failed before Telegram push',
      email_id: emailId,
      code: details.code,
      error: details.description,
    }));
  }

  await Promise.all(trackedRules.map(async ({ rule, downstreamId }) => {
    let deliveryError: unknown | null = null;
    try {
      if (rule.bot_id === null || !rule.bot_token.trim()) {
        throw new Error('Telegram 推送规则未绑定有效 Bot，请重新配置规则');
      }
      await sendTgNotification(rule.bot_token, rule.chat_id, {
        from: parsed.from_addr,
        to: parsed.to_addr,
        subject: parsed.subject,
        body: analysisBody,
        code,
      });
    } catch (error) {
      deliveryError = error;
      const details = downstreamErrorDetails(error);
      console.error(JSON.stringify({
        message: 'automatic Telegram push failed',
        email_id: emailId,
        rule_id: rule.id,
        code: details.code,
        error: details.description,
      }));
    }
    await recordDownstreamOutcome(env, emailId, downstreamId, 1, deliveryError, {
      channel: 'telegram',
      target: rule.chat_id,
      ruleId: rule.id,
      botId: rule.bot_id,
      botName: rule.bot_name,
    });
  }));
}

interface TgDeliveryRule extends TgRule {
  bot_name: string;
  bot_token: string;
}

interface BarkDeliveryRule extends BarkRule {
  endpoint_name: string;
  server_url: string;
  device_key: string;
}
