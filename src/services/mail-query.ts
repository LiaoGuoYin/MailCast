import {
  buildReadPrefixSqlFilter,
  buildSentPrefixSqlFilter,
  canReadPrefix,
  canSendFromPrefix,
  hasScope,
  hasWildcardPrefix,
  type Principal,
} from '../auth/principal';
import { normalizeSenderPrefix, validateSenderPrefix } from '../email/outbound';
import { parseReplyMetadata } from '../email/reply';
import { extractCleanEmailText, summarizeEmailText } from '../email/text';
import {
  getEmailDeliveryConfig,
  getEmailSenderConfig,
  getMcpSettings,
  selectedSenderAddress,
} from '../settings';
import { latestReceivingAddress, mailDomainFromAddress } from '../api/settings';
import type { EmailRecord, Env, SentEmailRecord } from '../types';

const PREFIX_SUGGESTION_LIMIT = 100;
const MAX_EMAIL_LIST_LIMIT = 50;
const DEFAULT_EMAIL_LIST_LIMIT = 20;
const MAX_EMAIL_DETAIL_CHARS = 20_000;
const DEFAULT_EMAIL_DETAIL_CHARS = 8_000;
const MAX_HTML_CLEAN_SLICE = 64 * 1024;
const WAIT_SUMMARY_MAX_CHARS = 2_000;
const DEFAULT_SEARCH_WINDOW_DAYS = 30;
const MAX_LINKS = 20;
const MAX_CODES = 5;

const STATIC_ASSET_EXT_RE = /\.(?:png|jpe?g|gif|svg|webp|ico|css|js|woff2?|ttf|eot|otf)(?:[?#]|$)/i;
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'()]+/gi;
const HREF_IN_HTML_RE = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
const LABELED_CODE_RE = /(?:verification\s*code|security\s*code|passcode|one-time\s*(?:code|password)|login\s*code|sign[- ]in\s*code|confirm(?:ation)?\s*code|auth(?:entication)?\s*code|\botp\b|\bpin\b|验证码|校验码|动态码|安全码|确认码)[\s:：#\-—=is为是]{0,24}\b([A-Z0-9](?:[A-Z0-9-]{2,10}[A-Z0-9]))\b/gi;
const STANDALONE_6DIGIT_RE = /(?:^|[\s:：(（\[【"'`>])(\d{6})(?=$|[\s.,;:!?。，；：！？)）\]】"'`<])/g;
const STANDALONE_HYPHEN_CODE_RE = /(?:^|[\s:：(（\[【"'`>])(\d{3}-\d{3})(?=$|[\s.,;:!?。，；：！？)）\]】"'`<])/g;

export interface ExtractedLink {
  url: string;
  host: string;
}

export interface SendQuotaSnapshot {
  instance_day_used: number;
  instance_day_limit: number;
  token_hour_used: number | null;
  token_hour_limit: number | null;
  token_day_used: number | null;
  token_day_limit: number | null;
}

export interface MailboxInfo {
  token_name: string | null;
  scopes: string[];
  prefixes: string[];
  allow_plus_tags: boolean;
  recipient_policy: 'allowlist' | 'any';
  recipient_allowlist: string[];
  receive_domain: string;
  send_domain: string;
  addresses: string[];
  send_configured: boolean;
  send_provider: string;
  quota: SendQuotaSnapshot;
  latest_email_id: number;
}

export interface EmailListFilter {
  prefix?: string;
  from?: string;
  subjectContains?: string;
  afterId?: number;
  beforeId?: number;
  since?: string;
  unreadOnly?: boolean;
  limit?: number;
}

export interface AgentEmailSummary {
  id: number;
  from_addr: string;
  envelope_from: string;
  to_addr: string;
  to_prefix: string;
  subject: string;
  snippet: string;
  is_read: boolean;
  created_at: string;
}

export interface AgentEmailDetail {
  id: number;
  from_addr: string;
  envelope_from: string;
  from_addr_authenticated: false;
  to_addr: string;
  to_prefix: string;
  reply_to_addr: string;
  is_read: boolean;
  created_at: string;
  untrusted: {
    subject: string;
    body_text: string;
    body_offset: number;
    body_total_chars: number;
    body_truncated: boolean;
    links: ExtractedLink[];
    code_candidates: string[];
  };
  replies: Array<{
    id: number;
    from_prefix: string;
    from_addr: string;
    to_addr: string;
    subject: string;
    status: string;
    created_at: string;
  }>;
}

export type ServiceError<Code extends string = string> = {
  ok: false;
  code: Code;
  message: string;
};

export async function listKnownPrefixes(db: D1Database): Promise<string[]> {
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

export async function listKnownPrefixesForPrincipal(
  db: D1Database,
  principal: Principal,
): Promise<string[]> {
  if (hasWildcardPrefix(principal)) {
    return listKnownPrefixes(db);
  }
  if (principal.kind !== 'agent') {
    return listKnownPrefixes(db);
  }
  return [...principal.prefixes];
}

export async function getLatestEmailId(db: D1Database): Promise<number> {
  const row = await db.prepare(
    'SELECT COALESCE(MAX(id), 0) AS latest_id FROM emails',
  ).first<{ latest_id: number }>();
  return Number(row?.latest_id ?? 0);
}

export async function getInstanceAgentDaySendCount(
  db: D1Database,
  nowMs = Date.now(),
): Promise<number> {
  const sinceDay = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  const row = await db.prepare(
    'SELECT COUNT(*) AS total FROM sent_emails WHERE agent_token_id IS NOT NULL AND created_at >= ?',
  ).bind(sinceDay).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

export async function getSendQuotaSnapshot(
  db: D1Database,
  principal: Principal,
  nowMs = Date.now(),
): Promise<SendQuotaSnapshot> {
  const sinceHour = new Date(nowMs - 60 * 60 * 1000).toISOString();
  const sinceDay = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();

  const [mcpSettings, instanceDayUsed] = await Promise.all([
    getMcpSettings(db),
    getInstanceAgentDaySendCount(db, nowMs),
  ]);

  if (principal.kind !== 'agent') {
    return {
      instance_day_used: instanceDayUsed,
      instance_day_limit: mcpSettings.daily_send_limit,
      token_hour_used: null,
      token_hour_limit: null,
      token_day_used: null,
      token_day_limit: null,
    };
  }

  const [hourRow, dayRow] = await Promise.all([
    db.prepare(
      'SELECT COUNT(*) AS total FROM sent_emails WHERE agent_token_id = ? AND created_at >= ?',
    ).bind(principal.tokenId, sinceHour).first<{ total: number }>(),
    db.prepare(
      'SELECT COUNT(*) AS total FROM sent_emails WHERE agent_token_id = ? AND created_at >= ?',
    ).bind(principal.tokenId, sinceDay).first<{ total: number }>(),
  ]);

  return {
    instance_day_used: instanceDayUsed,
    instance_day_limit: mcpSettings.daily_send_limit,
    token_hour_used: Number(hourRow?.total ?? 0),
    token_hour_limit: principal.sendLimitHour,
    token_day_used: Number(dayRow?.total ?? 0),
    token_day_limit: principal.sendLimitDay,
  };
}

export async function getMailboxInfoForPrincipal(
  env: Env,
  principal: Principal,
): Promise<MailboxInfo> {
  const [senderConfig, deliveryConfig, latestToAddr, prefixes, latestEmailId, quota] = await Promise.all([
    getEmailSenderConfig(env.DB, env.EMAIL_FROM_ADDRESS),
    getEmailDeliveryConfig(env.DB),
    latestReceivingAddress(env.DB),
    listKnownPrefixesForPrincipal(env.DB, principal),
    getLatestEmailId(env.DB),
    getSendQuotaSnapshot(env.DB, principal),
  ]);

  const receiveDomain = mailDomainFromAddress(latestToAddr);
  const sendDomain = mailDomainFromAddress(selectedSenderAddress(senderConfig)) || receiveDomain;
  const configured = deliveryConfig.provider === 'resend'
    ? Boolean(deliveryConfig.resend_api_key)
    : Boolean(env.EMAIL);

  const addressDomain = receiveDomain || sendDomain;
  const addresses = addressDomain
    ? prefixes.filter((p) => p !== '*').map((p) => `${p}@${addressDomain}`)
    : [];

  return {
    token_name: principal.kind === 'agent' ? principal.name : null,
    scopes: principal.kind === 'agent' ? [...principal.scopes] : ['mail:read', 'mail:send'],
    prefixes: principal.kind === 'agent' ? [...principal.prefixes] : prefixes,
    allow_plus_tags: principal.kind === 'agent' ? principal.allowPlusTags : true,
    recipient_policy: principal.kind === 'agent' ? principal.recipientPolicy : 'any',
    recipient_allowlist: principal.kind === 'agent' ? [...principal.recipientAllowlist] : [],
    receive_domain: receiveDomain,
    send_domain: sendDomain,
    addresses,
    send_configured: configured,
    send_provider: deliveryConfig.provider,
    quota,
    latest_email_id: latestEmailId,
  };
}

export function extractCodeCandidates(subject: string, cleanText: string): string[] {
  const candidates: string[] = [];
  const push = (raw: string) => {
    const code = raw.trim();
    if (!code || !/\d/.test(code)) return;
    if (candidates.includes(code)) return;
    if (candidates.length < MAX_CODES) candidates.push(code);
  };

  const combined = `${subject}\n${cleanText.slice(0, 6000)}`;

  for (const match of combined.matchAll(LABELED_CODE_RE)) {
    const candidate = match[1];
    if (candidate && candidate.length >= 4 && candidate.length <= 12) {
      push(candidate);
    }
  }
  for (const match of combined.matchAll(STANDALONE_HYPHEN_CODE_RE)) {
    if (match[1]) push(match[1]);
  }
  for (const match of combined.matchAll(STANDALONE_6DIGIT_RE)) {
    if (match[1]) push(match[1]);
  }

  return candidates;
}

export function extractLinks(cleanText: string, htmlBody = ''): ExtractedLink[] {
  const seen = new Set<string>();
  const links: ExtractedLink[] = [];

  const addCandidate = (raw: string) => {
    if (links.length >= MAX_LINKS) return;
    const cleaned = raw.trim().replace(/[.,;:!?)\]>'"]+$/, '');
    if (!cleaned || !/^https?:\/\//i.test(cleaned)) return;
    if (STATIC_ASSET_EXT_RE.test(cleaned)) return;
    try {
      const parsed = new URL(cleaned);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
      const normalized = parsed.toString();
      if (seen.has(normalized)) return;
      seen.add(normalized);
      links.push({ url: normalized, host: parsed.host.toLowerCase() });
    } catch {
      // Ignore malformed URLs
    }
  };

  for (const match of cleanText.slice(0, 16_000).matchAll(URL_IN_TEXT_RE)) {
    addCandidate(match[0]);
  }
  if (htmlBody) {
    for (const match of htmlBody.slice(0, MAX_HTML_CLEAN_SLICE).matchAll(HREF_IN_HTML_RE)) {
      addCandidate(match[1] ?? match[2] ?? '');
    }
  }

  return links;
}

export async function listEmailsForPrincipal(
  db: D1Database,
  principal: Principal,
  filter: EmailListFilter = {},
): Promise<
  | { ok: true; emails: AgentEmailSummary[]; has_more: boolean; next_before_id: number | null; latest_email_id: number }
  | ServiceError<'FORBIDDEN_SCOPE' | 'FORBIDDEN_PREFIX' | 'INVALID_PARAM'>
> {
  if (!hasScope(principal, 'mail:read')) {
    return { ok: false, code: 'FORBIDDEN_SCOPE', message: '当前 Token 没有读取邮件（mail:read）权限' };
  }

  const prefixFilter = buildReadPrefixSqlFilter(principal, filter.prefix);
  if (!prefixFilter.allowed) {
    return {
      ok: false,
      code: 'FORBIDDEN_PREFIX',
      message: filter.prefix
        ? `前缀「${filter.prefix}」不在当前 Token 允许范围内`
        : '当前 Token 未配置任何可读取的邮件前缀',
    };
  }

  const limit = Math.min(
    MAX_EMAIL_LIST_LIMIT,
    Math.max(1, Math.floor(filter.limit ?? DEFAULT_EMAIL_LIST_LIMIT)),
  );

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (prefixFilter.sql) {
    conditions.push(prefixFilter.sql);
    params.push(...prefixFilter.params);
  }
  if (filter.afterId !== undefined) {
    conditions.push('id > ?');
    params.push(filter.afterId);
  }
  if (filter.beforeId !== undefined) {
    conditions.push('id < ?');
    params.push(filter.beforeId);
  }
  if (filter.since) {
    conditions.push('created_at >= ?');
    params.push(filter.since);
  }
  if (filter.unreadOnly) {
    conditions.push('is_read = 0');
  }

  const fromFilter = filter.from?.trim() ?? '';
  const subjectFilter = filter.subjectContains?.trim() ?? '';
  if (fromFilter) {
    conditions.push('(lower(from_addr) LIKE ? OR lower(envelope_from) LIKE ?)');
    const pattern = `%${escapeLike(fromFilter.toLowerCase())}%`;
    params.push(pattern, pattern);
  }
  if (subjectFilter) {
    conditions.push("lower(subject) LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(subjectFilter.toLowerCase())}%`);
  }
  // Keep keyword scans bounded when neither `since` nor `afterId` is given.
  if ((fromFilter || subjectFilter) && !filter.since && filter.afterId === undefined) {
    const windowStart = new Date(
      Date.now() - DEFAULT_SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    conditions.push('created_at >= ?');
    params.push(windowStart);
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT
      id, from_addr, envelope_from, to_addr, to_prefix, subject, is_read, created_at,
      substr(COALESCE(text_body, ''), 1, 8192) AS text_preview,
      substr(COALESCE(html_body, ''), 1, 16384) AS html_preview
    FROM emails${where}
    ORDER BY id DESC
    LIMIT ?
  `;

  const [rowsResult, latestEmailId] = await Promise.all([
    db.prepare(sql).bind(...params, limit + 1).all<Record<string, unknown>>(),
    getLatestEmailId(db),
  ]);

  const rawRows = rowsResult.results ?? [];
  const hasMore = rawRows.length > limit;
  const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;

  const emails: AgentEmailSummary[] = pageRows.map((row) => {
    const rawText = typeof row.text_preview === 'string' ? row.text_preview : '';
    const rawHtml = typeof row.html_preview === 'string' ? row.html_preview : '';
    const subject = typeof row.subject === 'string' ? row.subject : '';
    const clean = extractCleanEmailText({ text_body: rawText, html_body: rawHtml, subject });
    const snippet = summarizeEmailText(clean, 140).replace(/\s+/g, ' ').trim();
    return {
      id: Number(row.id),
      from_addr: String(row.from_addr ?? ''),
      envelope_from: String(row.envelope_from ?? ''),
      to_addr: String(row.to_addr ?? ''),
      to_prefix: String(row.to_prefix ?? ''),
      subject,
      snippet,
      is_read: Boolean(row.is_read),
      created_at: String(row.created_at ?? ''),
    };
  });

  const nextBeforeId = hasMore && emails.length > 0 ? emails[emails.length - 1].id : null;
  return { ok: true, emails, has_more: hasMore, next_before_id: nextBeforeId, latest_email_id: latestEmailId };
}

export async function getEmailForPrincipal(
  db: D1Database,
  principal: Principal,
  emailId: number,
  options: { maxChars?: number; offset?: number } = {},
): Promise<
  | { ok: true; email: AgentEmailDetail }
  | ServiceError<'FORBIDDEN_SCOPE' | 'FORBIDDEN_PREFIX' | 'NOT_FOUND'>
> {
  if (!hasScope(principal, 'mail:read')) {
    return { ok: false, code: 'FORBIDDEN_SCOPE', message: '当前 Token 没有读取邮件（mail:read）权限' };
  }

  const row = await db.prepare(`
    SELECT
      id, from_addr, envelope_from, to_addr, to_prefix, subject,
      text_body, html_body, body_truncated, raw_body, raw_truncated,
      downstream_recorded, is_read, created_at
    FROM emails
    WHERE id = ?
  `).bind(emailId).first<EmailRecord>();

  if (!row) {
    return { ok: false, code: 'NOT_FOUND', message: `邮件 #${emailId} 不存在` };
  }
  if (!canReadPrefix(principal, row.to_prefix)) {
    return { ok: false, code: 'FORBIDDEN_PREFIX', message: `邮件 #${emailId} 不在当前 Token 的允许前缀范围内` };
  }

  const maxChars = Math.min(
    MAX_EMAIL_DETAIL_CHARS,
    Math.max(200, Math.floor(options.maxChars ?? DEFAULT_EMAIL_DETAIL_CHARS)),
  );
  const offset = Math.max(0, Math.floor(options.offset ?? 0));

  const boundedHtml = row.html_body ? row.html_body.slice(0, MAX_HTML_CLEAN_SLICE) : '';
  const cleanText = extractCleanEmailText({
    text_body: row.text_body,
    html_body: boundedHtml,
    subject: row.subject,
  });
  const totalChars = cleanText.length;
  const slicedBody = cleanText.slice(offset, offset + maxChars);
  const bodyTruncated = offset + slicedBody.length < totalChars || Boolean(row.body_truncated);

  const [replyMeta, repliesResult] = await Promise.all([
    parseReplyMetadata(row.raw_body, row.from_addr),
    db.prepare(`
      SELECT
        id, from_prefix, from_addr, to_addr, subject, status, created_at, agent_token_id
      FROM sent_emails
      WHERE reply_to_email_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 20
    `).bind(row.id).all<Pick<
      SentEmailRecord,
      'id' | 'from_prefix' | 'from_addr' | 'to_addr' | 'subject' | 'status' | 'created_at' | 'agent_token_id'
    >>(),
  ]);

  const visibleReplies = (repliesResult.results ?? [])
    .filter((reply) => {
      if (principal.kind === 'admin') return true;
      return canSendFromPrefix(principal, reply.from_prefix)
        || reply.agent_token_id === principal.tokenId;
    })
    .map((reply) => ({
      id: reply.id,
      from_prefix: reply.from_prefix,
      from_addr: reply.from_addr,
      to_addr: reply.to_addr,
      subject: reply.subject,
      status: reply.status,
      created_at: reply.created_at,
    }));

  return {
    ok: true,
    email: {
      id: row.id,
      from_addr: row.from_addr,
      envelope_from: row.envelope_from ?? '',
      from_addr_authenticated: false,
      to_addr: row.to_addr,
      to_prefix: row.to_prefix,
      reply_to_addr: replyMeta.replyAddress,
      is_read: Boolean(row.is_read),
      created_at: row.created_at,
      untrusted: {
        subject: row.subject,
        body_text: slicedBody,
        body_offset: offset,
        body_total_chars: totalChars,
        body_truncated: bodyTruncated,
        links: extractLinks(cleanText, boundedHtml),
        code_candidates: extractCodeCandidates(row.subject, cleanText),
      },
      replies: visibleReplies,
    },
  };
}

export interface WaitForEmailInput {
  prefix?: string;
  afterId?: number;
  since?: string;
  from?: string;
  subjectContains?: string;
  timeoutSeconds?: number;
}

export interface WaitForEmailMatched {
  id: number;
  from_addr: string;
  envelope_from: string;
  from_addr_authenticated: false;
  to_addr: string;
  to_prefix: string;
  created_at: string;
  untrusted: {
    subject: string;
    summary_text: string;
    links: ExtractedLink[];
    code_candidates: string[];
  };
}

export async function waitForEmailForPrincipal(
  db: D1Database,
  principal: Principal,
  input: WaitForEmailInput,
  options: {
    sleep?: (ms: number) => Promise<void>;
    pollIntervalMs?: number;
    now?: () => number;
  } = {},
): Promise<
  | { ok: true; found: true; cursor: number; email: WaitForEmailMatched }
  | { ok: true; found: false; cursor: number }
  | ServiceError<'FORBIDDEN_SCOPE' | 'FORBIDDEN_PREFIX' | 'INVALID_PARAM'>
> {
  if (!hasScope(principal, 'mail:read')) {
    return { ok: false, code: 'FORBIDDEN_SCOPE', message: '当前 Token 没有读取邮件（mail:read）权限' };
  }
  if (input.afterId === undefined && !input.since) {
    return {
      ok: false,
      code: 'INVALID_PARAM',
      message: 'wait_for_email 必须提供 after_id 或 since（建议先调用 get_mailbox_info 获取 latest_email_id）',
    };
  }

  const prefixFilter = buildReadPrefixSqlFilter(principal, input.prefix);
  if (!prefixFilter.allowed) {
    return {
      ok: false,
      code: 'FORBIDDEN_PREFIX',
      message: input.prefix
        ? `前缀「${input.prefix}」不在当前 Token 允许范围内`
        : '当前 Token 未配置任何可读取的邮件前缀',
    };
  }

  const timeoutSeconds = Math.min(25, Math.max(1, Math.floor(input.timeoutSeconds ?? 20)));
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 2500);
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const deadline = now() + timeoutSeconds * 1000;

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (prefixFilter.sql) {
    conditions.push(prefixFilter.sql);
    params.push(...prefixFilter.params);
  }
  if (input.afterId !== undefined) {
    conditions.push('id > ?');
    params.push(input.afterId);
  }
  if (input.since) {
    conditions.push('created_at >= ?');
    params.push(input.since);
  }
  const fromFilter = input.from?.trim() ?? '';
  if (fromFilter) {
    conditions.push('(lower(from_addr) LIKE ? OR lower(envelope_from) LIKE ?)');
    const pattern = `%${escapeLike(fromFilter.toLowerCase())}%`;
    params.push(pattern, pattern);
  }
  const subjectFilter = input.subjectContains?.trim() ?? '';
  if (subjectFilter) {
    conditions.push("lower(subject) LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(subjectFilter.toLowerCase())}%`);
  }

  const query = `
    SELECT
      id, from_addr, envelope_from, to_addr, to_prefix, subject,
      substr(COALESCE(text_body, ''), 1, 32768) AS text_body,
      substr(COALESCE(html_body, ''), 1, 65536) AS html_body,
      created_at
    FROM emails
    WHERE ${conditions.join(' AND ')}
    ORDER BY id ASC
    LIMIT 1
  `;

  while (true) {
    const hit = await db.prepare(query).bind(...params).first<{
      id: number;
      from_addr: string;
      envelope_from: string;
      to_addr: string;
      to_prefix: string;
      subject: string;
      text_body: string;
      html_body: string;
      created_at: string;
    }>();

    if (hit) {
      const cleanText = extractCleanEmailText({
        text_body: hit.text_body,
        html_body: hit.html_body,
        subject: hit.subject,
      });
      return {
        ok: true,
        found: true,
        cursor: hit.id,
        email: {
          id: hit.id,
          from_addr: hit.from_addr,
          envelope_from: hit.envelope_from ?? '',
          from_addr_authenticated: false,
          to_addr: hit.to_addr,
          to_prefix: hit.to_prefix,
          created_at: hit.created_at,
          untrusted: {
            subject: hit.subject,
            summary_text: summarizeEmailText(cleanText, WAIT_SUMMARY_MAX_CHARS),
            links: extractLinks(cleanText, hit.html_body),
            code_candidates: extractCodeCandidates(hit.subject, cleanText),
          },
        },
      };
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  const cursor = Math.max(input.afterId ?? 0, await getLatestEmailId(db));
  return { ok: true, found: false, cursor };
}

export async function listSentEmailsForPrincipal(
  db: D1Database,
  principal: Principal,
  filter: { prefix?: string; status?: SentEmailRecord['status']; beforeId?: number; limit?: number } = {},
): Promise<
  | { ok: true; emails: SentEmailRecord[]; has_more: boolean; next_before_id: number | null }
  | ServiceError<'FORBIDDEN_SCOPE' | 'FORBIDDEN_PREFIX'>
> {
  if (!hasScope(principal, 'mail:read') && !hasScope(principal, 'mail:send')) {
    return { ok: false, code: 'FORBIDDEN_SCOPE', message: '当前 Token 没有查看发件记录的权限' };
  }

  const prefixFilter = buildSentPrefixSqlFilter(principal, filter.prefix);
  if (!prefixFilter.allowed) {
    return {
      ok: false,
      code: 'FORBIDDEN_PREFIX',
      message: filter.prefix
        ? `前缀「${filter.prefix}」不在当前 Token 允许范围内`
        : '当前 Token 未配置任何允许的邮件前缀',
    };
  }

  const limit = Math.min(
    MAX_EMAIL_LIST_LIMIT,
    Math.max(1, Math.floor(filter.limit ?? DEFAULT_EMAIL_LIST_LIMIT)),
  );
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (prefixFilter.sql) {
    conditions.push(prefixFilter.sql);
    params.push(...prefixFilter.params);
  }
  if (filter.status) {
    conditions.push('status = ?');
    params.push(filter.status);
  }
  if (filter.beforeId !== undefined) {
    conditions.push('id < ?');
    params.push(filter.beforeId);
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const result = await db.prepare(`
    SELECT
      id, from_prefix, from_addr, to_addr, reply_to, subject, text_body,
      reply_to_email_id, provider, provider_message_id, status, error, created_at,
      agent_token_id, idempotency_key
    FROM sent_emails${where}
    ORDER BY id DESC
    LIMIT ?
  `).bind(...params, limit + 1).all<SentEmailRecord>();

  const rows = result.results ?? [];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const nextBeforeId = hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1].id : null;

  return { ok: true, emails: pageRows, has_more: hasMore, next_before_id: nextBeforeId };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
