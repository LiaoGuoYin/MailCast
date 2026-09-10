import { Hono } from 'hono';
import type { EmailDownstream, Env, EmailRecord } from '../types';
import {
  emailSendErrorPayload,
  validateEmailAddress,
} from '../email/forward';
import {
  claimDownstreamRetry,
  createDownstream,
  deliverStoredDownstream,
  downstreamErrorDetails,
  settleDownstream,
} from '../email/downstream';
import {
  getTelegramBot,
  normalizeTelegramBotId,
  telegramChatIdProblem,
} from '../telegram/bots';
import { requestIp, safeRecordAuditLog } from '../audit';
import { getBarkEndpoint, normalizeBarkEndpointId } from '../bark/endpoints';

export const emailRoutes = new Hono<{ Bindings: Env }>();

export interface EmailDetail extends Omit<
  EmailRecord,
  'body_truncated' | 'raw_truncated' | 'downstream_recorded' | 'is_read'
> {
  body_truncated: boolean;
  raw_truncated: boolean;
  downstream_recorded: boolean;
  is_read: boolean;
}

interface DownstreamListRow extends EmailDownstream {
  is_stale: number;
}

interface RetryDownstreamRow extends EmailRecord {
  downstream_id: number;
  channel: EmailDownstream['channel'];
  source: EmailDownstream['source'];
  rule_id: number | null;
  target: string;
  telegram_bot_id: number | null;
  telegram_bot_name: string;
  bark_endpoint_id: number | null;
  bark_endpoint_name: string;
  status: EmailDownstream['status'];
  attempt_count: number;
  last_error: string;
  last_triggered_at: string;
  downstream_created_at: string;
  downstream_updated_at: string;
}

async function countUnreadEmails(db: D1Database): Promise<number> {
  const row = await db.prepare(
    'SELECT COUNT(*) AS total FROM emails WHERE is_read = 0',
  ).first<{ total: number }>();
  return row?.total ?? 0;
}

async function fetchEmailById(db: D1Database, id: string): Promise<EmailRecord | null> {
  return db.prepare(`
    SELECT
      id, from_addr, to_addr, to_prefix, subject,
      text_body, html_body, body_truncated, raw_body, raw_truncated,
      downstream_recorded, is_read, created_at
    FROM emails
    WHERE id = ?
  `).bind(id).first<EmailRecord>();
}

export function normalizeEmailDetail(email: EmailRecord): EmailDetail {
  return {
    id: email.id,
    from_addr: email.from_addr,
    to_addr: email.to_addr,
    to_prefix: email.to_prefix,
    subject: email.subject,
    text_body: email.text_body,
    html_body: email.html_body,
    body_truncated: Boolean(email.body_truncated),
    raw_body: email.raw_body,
    raw_truncated: Boolean(email.raw_truncated),
    downstream_recorded: Boolean(email.downstream_recorded),
    is_read: Boolean(email.is_read),
    created_at: email.created_at,
  };
}

emailRoutes.get('/', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 20));
  const prefix = c.req.query('prefix');
  const offset = (page - 1) * limit;

  let countQuery = 'SELECT COUNT(*) as total FROM emails';
  let dataQuery = `
    SELECT
      id, from_addr, to_addr, to_prefix, subject, is_read, created_at,
      substr(
        CASE WHEN text_body <> '' THEN text_body ELSE COALESCE(html_body, '') END,
        1,
        4096
      ) AS body_preview
    FROM emails`;
  const params: unknown[] = [];

  if (prefix) {
    const where = ' WHERE to_prefix = ?';
    countQuery += where;
    dataQuery += where;
    params.push(prefix);
  }

  dataQuery += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';

  const [countResult, unreadCount, dataResult] = await Promise.all([
    c.env.DB.prepare(countQuery).bind(...params).first<{ total: number }>(),
    countUnreadEmails(c.env.DB),
    c.env.DB.prepare(dataQuery).bind(...params, limit, offset).all(),
  ]);

  return c.json({
    data: dataResult.results.map((email) => ({
      ...email,
      is_read: Boolean(email.is_read),
    })),
    total: countResult?.total ?? 0,
    unread_count: unreadCount,
    page,
    limit,
  });
});

emailRoutes.get('/unread-count', async (c) => {
  const unreadCount = await countUnreadEmails(c.env.DB);

  return c.json({ unread_count: unreadCount });
});

emailRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const email = await fetchEmailById(c.env.DB, id);

  if (!email) {
    return c.json({ error: 'Not found' }, 404);
  }

  return c.json(normalizeEmailDetail(email));
});

emailRoutes.patch('/:id/read', async (c) => {
  const id = c.req.param('id');
  const email = await c.env.DB.prepare(
    'SELECT id FROM emails WHERE id = ?',
  ).bind(id).first<{ id: number }>();

  if (!email) {
    return c.json({ error: 'Not found' }, 404);
  }

  await c.env.DB.prepare(
    'UPDATE emails SET is_read = 1 WHERE id = ? AND is_read = 0',
  ).bind(id).run();

  const unreadCount = await countUnreadEmails(c.env.DB);

  return c.json({
    success: true,
    unread_count: unreadCount,
  });
});

emailRoutes.get('/:id/downstreams', async (c) => {
  const id = c.req.param('id');
  const email = await c.env.DB.prepare(
    'SELECT downstream_recorded FROM emails WHERE id = ?',
  ).bind(id).first<{ downstream_recorded: number | null }>();

  if (!email) {
    return c.json({ error: 'Not found' }, 404);
  }

  const result = await c.env.DB.prepare(`
    SELECT
      id, email_id, channel, source, rule_id, target,
      telegram_bot_id, telegram_bot_name, bark_endpoint_id, bark_endpoint_name,
      status, attempt_count,
      last_error, last_triggered_at, created_at, updated_at,
      CASE
        WHEN status = 'pending'
          AND julianday(last_triggered_at) < julianday('now', '-2 minutes')
        THEN 1 ELSE 0
      END AS is_stale
    FROM email_downstreams
    WHERE email_id = ?
    ORDER BY created_at ASC, id ASC
  `).bind(id).all<DownstreamListRow>();

  return c.json({
    tracked: Boolean(email.downstream_recorded),
    data: result.results.map((item) => ({
      ...item,
      is_stale: Boolean(item.is_stale),
    })),
  });
});

emailRoutes.post('/:id/forward', async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  const to = body && typeof body === 'object' && 'to' in body && typeof body.to === 'string'
    ? body.to.trim()
    : '';
  const problem = validateEmailAddress(to);
  if (problem) {
    return c.json({ error: problem }, 400);
  }

  const email = await fetchEmailById(c.env.DB, c.req.param('id'));

  if (!email) {
    return c.json({ error: 'Not found' }, 404);
  }

  const detail = normalizeEmailDetail(email);
  const downstreamId = await createDownstream(c.env.DB, {
    emailId: detail.id,
    channel: 'forward',
    source: 'quick_forward',
    target: to,
  });

  let messageId: string | null;
  try {
    messageId = await deliverStoredDownstream(c.env, detail, {
      channel: 'forward',
      target: to,
    });
  } catch (error) {
    await settleDownstream(c.env.DB, downstreamId, 1, error).catch((settleError) => {
      console.error(JSON.stringify({
        message: 'quick forward result update failed',
        email_id: detail.id,
        downstream_id: downstreamId,
        error: downstreamErrorDetails(settleError).description,
      }));
    });
    const payload = emailSendErrorPayload(error);
    console.error(JSON.stringify({
      message: 'email forward failed',
      email_id: detail.id,
      target_domain: to.split('@')[1],
      code: payload.email.code,
      error: payload.email.description,
    }));
    await logDelivery(c.env.DB, c.req.raw, {
      channel: 'forward', status: 'failed', emailId: detail.id, downstreamId,
      target: to, attempt: 1, source: 'manual', error: payload.email.description,
    });
    return c.json(payload, 502);
  }

  try {
    await settleDownstream(c.env.DB, downstreamId, 1, null);
  } catch (error) {
    const details = downstreamErrorDetails(error);
    console.error(JSON.stringify({
      message: 'quick forward success result update failed',
      email_id: detail.id,
      downstream_id: downstreamId,
      code: details.code,
      error: details.description,
    }));
    return c.json({
      error: '邮件已发送，但状态保存失败；请勿立即重复操作',
      downstream: details,
    }, 500);
  }

  await logDelivery(c.env.DB, c.req.raw, {
    channel: 'forward', status: 'success', emailId: detail.id, downstreamId,
    target: to, attempt: 1, source: 'manual',
  });

  return c.json({ success: true, message_id: messageId, downstream_id: downstreamId });
});

emailRoutes.post('/:id/telegram', async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  const chatId = body && typeof body === 'object'
    && 'chat_id' in body && typeof body.chat_id === 'string'
    ? body.chat_id.trim()
    : '';
  const botId = body && typeof body === 'object' && 'bot_id' in body
    ? normalizeTelegramBotId(body.bot_id)
    : null;

  const chatIdError = telegramChatIdProblem(chatId);
  if (chatIdError) return c.json({ error: chatIdError }, 400);
  if (botId === null) return c.json({ error: '请选择 Telegram Bot' }, 400);

  const bot = await getTelegramBot(c.env.DB, botId);
  if (!bot) return c.json({ error: '选择的 Telegram Bot 不存在' }, 400);

  const email = await fetchEmailById(c.env.DB, c.req.param('id'));

  if (!email) return c.json({ error: 'Not found' }, 404);

  const detail = normalizeEmailDetail(email);
  const downstreamId = await createDownstream(c.env.DB, {
    emailId: detail.id,
    channel: 'telegram',
    source: 'quick_forward',
    target: chatId,
    telegramBotId: bot.id,
    telegramBotName: bot.name,
  });

  try {
    await deliverStoredDownstream(c.env, detail, {
      channel: 'telegram',
      target: chatId,
      telegram_bot_id: bot.id,
    });
  } catch (error) {
    await settleDownstream(c.env.DB, downstreamId, 1, error).catch((settleError) => {
      console.error(JSON.stringify({
        message: 'manual Telegram result update failed',
        email_id: detail.id,
        downstream_id: downstreamId,
        error: downstreamErrorDetails(settleError).description,
      }));
    });
    const details = downstreamErrorDetails(error);
    console.error(JSON.stringify({
      message: 'manual Telegram push failed',
      email_id: detail.id,
      downstream_id: downstreamId,
      bot_id: bot.id,
      code: details.code,
      error: details.description,
    }));
    await logDelivery(c.env.DB, c.req.raw, {
      channel: 'telegram', status: 'failed', emailId: detail.id, downstreamId,
      target: chatId, attempt: 1, source: 'manual', botId: bot.id,
      botName: bot.name, error: details.description,
    });
    return c.json({ error: 'Telegram 推送失败', downstream: details }, 502);
  }

  try {
    await settleDownstream(c.env.DB, downstreamId, 1, null);
  } catch (error) {
    const details = downstreamErrorDetails(error);
    console.error(JSON.stringify({
      message: 'manual Telegram success result update failed',
      email_id: detail.id,
      downstream_id: downstreamId,
      code: details.code,
      error: details.description,
    }));
    return c.json({
      error: 'Telegram 已推送，但状态保存失败；请勿立即重复操作',
      downstream: details,
    }, 500);
  }

  await logDelivery(c.env.DB, c.req.raw, {
    channel: 'telegram', status: 'success', emailId: detail.id, downstreamId,
    target: chatId, attempt: 1, source: 'manual', botId: bot.id, botName: bot.name,
  });

  return c.json({ success: true, downstream_id: downstreamId });
});

emailRoutes.post('/:id/bark', async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  const endpointId = body && typeof body === 'object' && 'endpoint_id' in body
    ? normalizeBarkEndpointId(body.endpoint_id)
    : null;
  if (endpointId === null) return c.json({ error: '请选择 Bark 目标' }, 400);
  const endpoint = await getBarkEndpoint(c.env.DB, endpointId);
  if (!endpoint) return c.json({ error: '选择的 Bark 目标不存在' }, 400);

  const email = await fetchEmailById(c.env.DB, c.req.param('id'));
  if (!email) return c.json({ error: 'Not found' }, 404);

  const detail = normalizeEmailDetail(email);
  const downstreamId = await createDownstream(c.env.DB, {
    emailId: detail.id,
    channel: 'bark',
    source: 'quick_forward',
    target: endpoint.name,
    barkEndpointId: endpoint.id,
    barkEndpointName: endpoint.name,
  });

  try {
    await deliverStoredDownstream(c.env, detail, {
      channel: 'bark', target: endpoint.name, bark_endpoint_id: endpoint.id,
    });
  } catch (error) {
    await settleDownstream(c.env.DB, downstreamId, 1, error).catch(() => undefined);
    const details = downstreamErrorDetails(error);
    await logDelivery(c.env.DB, c.req.raw, {
      channel: 'bark', status: 'failed', emailId: detail.id, downstreamId,
      target: endpoint.name, attempt: 1, source: 'manual',
      barkEndpointId: endpoint.id, barkEndpointName: endpoint.name,
      error: details.description,
    });
    return c.json({ error: 'Bark 推送失败', downstream: details }, 502);
  }

  await settleDownstream(c.env.DB, downstreamId, 1, null);
  await logDelivery(c.env.DB, c.req.raw, {
    channel: 'bark', status: 'success', emailId: detail.id, downstreamId,
    target: endpoint.name, attempt: 1, source: 'manual',
    barkEndpointId: endpoint.id, barkEndpointName: endpoint.name,
  });
  return c.json({ success: true, downstream_id: downstreamId });
});

emailRoutes.post('/:id/downstreams/:downstreamId/retry', async (c) => {
  const emailId = c.req.param('id');
  const downstreamId = c.req.param('downstreamId');
  const row = await c.env.DB.prepare(`
    SELECT
      e.id, e.from_addr, e.to_addr, e.to_prefix, e.subject,
      e.text_body, e.html_body, e.body_truncated, e.raw_body, e.raw_truncated,
      e.downstream_recorded, e.is_read, e.created_at,
      d.id AS downstream_id,
      d.channel, d.source, d.rule_id, d.target,
      d.telegram_bot_id, d.telegram_bot_name,
      d.bark_endpoint_id, d.bark_endpoint_name, d.status, d.attempt_count,
      d.last_error, d.last_triggered_at,
      d.created_at AS downstream_created_at,
      d.updated_at AS downstream_updated_at
    FROM email_downstreams d
    JOIN emails e ON e.id = d.email_id
    WHERE e.id = ? AND d.id = ?
  `).bind(emailId, downstreamId).first<RetryDownstreamRow>();

  if (!row) {
    return c.json({ error: '下游记录不存在' }, 404);
  }

  const claimed = await claimDownstreamRetry(c.env.DB, row.id, row.downstream_id);
  if (!claimed) {
    return c.json({ error: '该下游正在执行，请稍后刷新' }, 409);
  }

  const email = normalizeEmailDetail(row);
  try {
    await deliverStoredDownstream(c.env, email, {
      channel: row.channel,
      target: row.target,
      telegram_bot_id: row.telegram_bot_id,
      bark_endpoint_id: row.bark_endpoint_id,
    });
  } catch (error) {
    await settleDownstream(
      c.env.DB,
      row.downstream_id,
      row.attempt_count + 1,
      error,
    ).catch((settleError) => {
      console.error(JSON.stringify({
        message: 'manual downstream failure result update failed',
        email_id: row.id,
        downstream_id: row.downstream_id,
        error: downstreamErrorDetails(settleError).description,
      }));
    });
    const details = downstreamErrorDetails(error);
    console.error(JSON.stringify({
      message: 'manual downstream retry failed',
      email_id: row.id,
      downstream_id: row.downstream_id,
      channel: row.channel,
      code: details.code,
      error: details.description,
    }));
    await logDelivery(c.env.DB, c.req.raw, {
      channel: row.channel, status: 'failed', emailId: row.id,
      downstreamId: row.downstream_id, target: row.target,
      attempt: row.attempt_count + 1, source: 'retry', botId: row.telegram_bot_id,
      botName: row.telegram_bot_name, barkEndpointId: row.bark_endpoint_id,
      barkEndpointName: row.bark_endpoint_name, error: details.description,
    });
    return c.json({ error: '再次触发失败', downstream: details }, 502);
  }

  try {
    await settleDownstream(c.env.DB, row.downstream_id, row.attempt_count + 1, null);
  } catch (error) {
    const details = downstreamErrorDetails(error);
    console.error(JSON.stringify({
      message: 'manual downstream success result update failed',
      email_id: row.id,
      downstream_id: row.downstream_id,
      code: details.code,
      error: details.description,
    }));
    return c.json({
      error: '下游已触发，但状态保存失败；请勿立即重复操作',
      downstream: details,
    }, 500);
  }

  await logDelivery(c.env.DB, c.req.raw, {
    channel: row.channel, status: 'success', emailId: row.id,
    downstreamId: row.downstream_id, target: row.target,
    attempt: row.attempt_count + 1, source: 'retry', botId: row.telegram_bot_id,
    botName: row.telegram_bot_name, barkEndpointId: row.bark_endpoint_id,
    barkEndpointName: row.bark_endpoint_name,
  });

  return c.json({ success: true });
});

emailRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const email = await c.env.DB.prepare(
    'SELECT subject, from_addr, to_addr FROM emails WHERE id = ?',
  ).bind(id).first<{ subject: string; from_addr: string; to_addr: string }>();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM email_downstreams WHERE email_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM emails WHERE id = ?').bind(id),
  ]);
  await safeRecordAuditLog(c.env.DB, {
    category: 'email', action: 'email.delete', status: 'success', actor: 'admin',
    targetType: 'email', targetId: id,
    summary: email ? `已删除邮件“${email.subject || '（无主题）'}”` : `已删除邮件 #${id}`,
    details: email ?? {}, ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true });
});

async function logDelivery(
  db: D1Database,
  request: Request,
  input: {
    channel: EmailDownstream['channel'];
    status: 'success' | 'failed';
    emailId: number;
    downstreamId: number;
    target: string;
    attempt: number;
    source: 'manual' | 'retry';
    botId?: number | null;
    botName?: string;
    barkEndpointId?: number | null;
    barkEndpointName?: string;
    error?: string;
  },
): Promise<void> {
  const channelName = input.channel === 'forward'
    ? '邮件转发'
    : input.channel === 'telegram' ? 'Telegram 推送' : 'Bark 推送';
  const verb = input.source === 'retry' ? '再次触发' : '手动触发';
  await safeRecordAuditLog(db, {
    category: 'delivery',
    action: `delivery.${input.channel}.${input.source}`,
    status: input.status,
    actor: 'admin',
    targetType: 'email_downstream',
    targetId: input.downstreamId,
    summary: `${verb}${channelName}${input.status === 'success' ? '成功' : '失败'}：${input.target}`,
    details: {
      email_id: input.emailId,
      downstream_id: input.downstreamId,
      channel: input.channel,
      target: input.target,
      attempt: input.attempt,
      bot_id: input.botId ?? null,
      bot_name: input.botName ?? '',
      bark_endpoint_id: input.barkEndpointId ?? null,
      bark_endpoint_name: input.barkEndpointName ?? '',
      ...(input.error ? { error: input.error } : {}),
    },
    ipAddress: requestIp(request),
  });
}
