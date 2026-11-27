import { validateEmailAddress } from '../email/forward';
import { normalizeSenderPrefix, validateSenderPrefix } from '../email/outbound';
import type {
  AgentRecipientPolicy,
  AgentScope,
  AgentTokenRow,
  AgentTokenSummary,
} from '../types';
import type { AgentPrincipal } from './principal';

const TOKEN_PREFIX = 'mc_';
const TOKEN_BYTES = 32;
const AGENT_TOKEN_RE = /^mc_[A-Za-z0-9_-]{43}$/;
const DOMAIN_RULE_RE = /^@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_TOKEN_NAME_LENGTH = 60;
const MAX_PREFIX_COUNT = 50;
const MAX_ALLOWLIST_COUNT = 100;
const DEFAULT_SEND_LIMIT_HOUR = 10;
const DEFAULT_SEND_LIMIT_DAY = 30;
const DEFAULT_EXPIRES_IN_DAYS = 90;
const MAX_EXPIRES_IN_DAYS = 3650;
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

const VALID_SCOPES: ReadonlySet<AgentScope> = new Set(['mail:read', 'mail:send']);
const encoder = new TextEncoder();

export interface CreateAgentTokenInput {
  name: string;
  scopes: AgentScope[];
  prefixes: string[];
  allowPlusTags: boolean;
  recipientPolicy: AgentRecipientPolicy;
  recipientAllowlist: string[];
  sendLimitHour: number;
  sendLimitDay: number;
  expiresInDays: number | null;
}

export interface CreatedAgentToken {
  token: string;
  item: AgentTokenSummary;
}

export function isAgentTokenFormat(token: string): boolean {
  return AGENT_TOKEN_RE.test(token);
}

export function agentTokenHint(token: string): string {
  const normalized = token.trim();
  if (!normalized) return '';
  return `${TOKEN_PREFIX}…${normalized.slice(-4)}`;
}

export async function hashAgentToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return encodeBase64Url(new Uint8Array(digest));
}

export function generateAgentToken(): string {
  const random = encodeBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  return `${TOKEN_PREFIX}${random}`;
}

export function validateAllowlistEntry(raw: string): { value: string; error: null } | { value: ''; error: string } {
  const value = raw.trim().toLowerCase();
  if (!value) return { value: '', error: '白名单条目不能为空' };
  if (value.startsWith('@')) {
    if (!DOMAIN_RULE_RE.test(value)) {
      return { value: '', error: `无效的域名白名单规则：${raw}（格式应为 @example.com）` };
    }
    return { value, error: null };
  }
  if (validateEmailAddress(value) !== null) {
    return { value: '', error: `无效的收件人白名单条目：${raw}（请输入完整邮箱或 @domain.com）` };
  }
  return { value, error: null };
}

export function parseCreateAgentTokenInput(
  raw: unknown,
): { ok: true; data: CreateAgentTokenInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: '无效的请求格式' };
  }
  const body = raw as Record<string, unknown>;

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { ok: false, error: '请填写 Token 名称' };
  if (name.length > MAX_TOKEN_NAME_LENGTH) {
    return { ok: false, error: `Token 名称最多 ${MAX_TOKEN_NAME_LENGTH} 个字符` };
  }

  if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
    return { ok: false, error: '请至少选择一项权限（读取或发信）' };
  }
  const scopes: AgentScope[] = [];
  for (const item of body.scopes) {
    if (typeof item !== 'string' || !VALID_SCOPES.has(item as AgentScope)) {
      return { ok: false, error: `无效的权限项：${String(item)}` };
    }
    if (!scopes.includes(item as AgentScope)) {
      scopes.push(item as AgentScope);
    }
  }

  if (!Array.isArray(body.prefixes) || body.prefixes.length === 0) {
    return { ok: false, error: '请至少指定一个允许的邮件前缀（或使用 *）' };
  }
  if (body.prefixes.length > MAX_PREFIX_COUNT) {
    return { ok: false, error: `前缀数量不能超过 ${MAX_PREFIX_COUNT} 个` };
  }
  const prefixes: string[] = [];
  for (const item of body.prefixes) {
    if (typeof item !== 'string') {
      return { ok: false, error: '前缀格式不正确' };
    }
    const normalized = normalizeSenderPrefix(item);
    if (!normalized) continue;
    if (normalized === '*') {
      if (!prefixes.includes('*')) prefixes.push('*');
      continue;
    }
    const problem = validateSenderPrefix(normalized);
    if (problem) return { ok: false, error: `前缀「${item}」无效：${problem}` };
    if (!prefixes.includes(normalized)) prefixes.push(normalized);
  }
  if (prefixes.length === 0) {
    return { ok: false, error: '请至少指定一个有效的邮件前缀' };
  }
  const finalPrefixes = prefixes.includes('*') ? ['*'] : prefixes;

  const allowPlusTags = body.allow_plus_tags === undefined
    ? true
    : Boolean(body.allow_plus_tags);

  const recipientPolicyRaw = body.recipient_policy === undefined
    ? 'allowlist'
    : body.recipient_policy;
  if (recipientPolicyRaw !== 'allowlist' && recipientPolicyRaw !== 'any') {
    return { ok: false, error: '收件人策略必须为 allowlist 或 any' };
  }
  const recipientPolicy: AgentRecipientPolicy = recipientPolicyRaw;

  const rawAllowlist = Array.isArray(body.recipient_allowlist) ? body.recipient_allowlist : [];
  if (rawAllowlist.length > MAX_ALLOWLIST_COUNT) {
    return { ok: false, error: `收件人白名单最多 ${MAX_ALLOWLIST_COUNT} 条` };
  }
  const recipientAllowlist: string[] = [];
  for (const entry of rawAllowlist) {
    if (typeof entry !== 'string') {
      return { ok: false, error: '收件人白名单格式不正确' };
    }
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const checked = validateAllowlistEntry(trimmed);
    if (checked.error) return { ok: false, error: checked.error };
    if (!recipientAllowlist.includes(checked.value)) {
      recipientAllowlist.push(checked.value);
    }
  }
  if (scopes.includes('mail:send') && recipientPolicy === 'allowlist' && recipientAllowlist.length === 0) {
    return { ok: false, error: '启用发信且使用白名单策略时，请至少填写一个允许的收件邮箱或 @域名' };
  }

  const sendLimitHour = parsePositiveInt(body.send_limit_hour, DEFAULT_SEND_LIMIT_HOUR, 1, 1000);
  if (sendLimitHour === null) {
    return { ok: false, error: '每小时发信上限需为 1–1000 的整数' };
  }
  const sendLimitDay = parsePositiveInt(body.send_limit_day, DEFAULT_SEND_LIMIT_DAY, 1, 10000);
  if (sendLimitDay === null) {
    return { ok: false, error: '每日发信上限需为 1–10000 的整数' };
  }

  let expiresInDays: number | null;
  if (body.expires_in_days === null || body.expires_in_days === '') {
    expiresInDays = null;
  } else if (body.expires_in_days === undefined) {
    expiresInDays = DEFAULT_EXPIRES_IN_DAYS;
  } else {
    const parsedDays = parsePositiveInt(body.expires_in_days, DEFAULT_EXPIRES_IN_DAYS, 1, MAX_EXPIRES_IN_DAYS);
    if (parsedDays === null) {
      return { ok: false, error: `有效期天数需为 1–${MAX_EXPIRES_IN_DAYS} 的整数，或留空表示永不过期` };
    }
    expiresInDays = parsedDays;
  }

  return {
    ok: true,
    data: {
      name,
      scopes,
      prefixes: finalPrefixes,
      allowPlusTags,
      recipientPolicy,
      recipientAllowlist,
      sendLimitHour,
      sendLimitDay,
      expiresInDays,
    },
  };
}

export function normalizeAgentTokenId(value: unknown): number | null {
  const num = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}

export function toAgentTokenSummary(row: AgentTokenRow, nowIso = new Date().toISOString()): AgentTokenSummary {
  const status: AgentTokenSummary['status'] = row.revoked_at
    ? 'revoked'
    : row.expires_at && row.expires_at <= nowIso
      ? 'expired'
      : 'active';

  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    token_hint: row.token_hint,
    scopes: parseStringArray<AgentScope>(row.scopes).filter((scope) => VALID_SCOPES.has(scope)),
    prefixes: parseStringArray<string>(row.prefixes),
    allow_plus_tags: Boolean(row.allow_plus_tags),
    recipient_policy: row.recipient_policy,
    recipient_allowlist: parseStringArray<string>(row.recipient_allowlist),
    send_limit_hour: row.send_limit_hour,
    send_limit_day: row.send_limit_day,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    last_used_at: row.last_used_at,
    last_used_ip: row.last_used_ip,
    created_at: row.created_at,
    updated_at: row.updated_at,
    status,
  };
}

export async function createAgentToken(
  db: D1Database,
  input: CreateAgentTokenInput,
): Promise<CreatedAgentToken> {
  const token = generateAgentToken();
  const tokenHash = await hashAgentToken(token);
  const tokenHint = agentTokenHint(token);
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = input.expiresInDays === null
    ? null
    : new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000).toISOString();

  const result = await db.prepare(`
    INSERT INTO agent_tokens
      (name, kind, token_hash, token_hint, scopes, prefixes, allow_plus_tags,
       recipient_policy, recipient_allowlist, send_limit_hour, send_limit_day,
       expires_at, revoked_at, last_used_at, last_used_ip, created_at, updated_at)
    VALUES (?, 'static', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '', ?, ?)
  `).bind(
    input.name,
    tokenHash,
    tokenHint,
    JSON.stringify(input.scopes),
    JSON.stringify(input.prefixes),
    input.allowPlusTags ? 1 : 0,
    input.recipientPolicy,
    JSON.stringify(input.recipientAllowlist),
    input.sendLimitHour,
    input.sendLimitDay,
    expiresAt,
    nowIso,
    nowIso,
  ).run();

  const id = Number(result.meta.last_row_id);
  const item: AgentTokenSummary = {
    id,
    name: input.name,
    kind: 'static',
    token_hint: tokenHint,
    scopes: input.scopes,
    prefixes: input.prefixes,
    allow_plus_tags: input.allowPlusTags,
    recipient_policy: input.recipientPolicy,
    recipient_allowlist: input.recipientAllowlist,
    send_limit_hour: input.sendLimitHour,
    send_limit_day: input.sendLimitDay,
    expires_at: expiresAt,
    revoked_at: null,
    last_used_at: null,
    last_used_ip: '',
    created_at: nowIso,
    updated_at: nowIso,
    status: 'active',
  };

  return { token, item };
}

export async function listAgentTokens(db: D1Database): Promise<AgentTokenSummary[]> {
  const rows = await db.prepare(`
    SELECT
      id, name, kind, token_hash, token_hint, scopes, prefixes, allow_plus_tags,
      recipient_policy, recipient_allowlist, send_limit_hour, send_limit_day,
      expires_at, revoked_at, last_used_at, last_used_ip, created_at, updated_at
    FROM agent_tokens
    ORDER BY
      CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END ASC,
      created_at DESC,
      id DESC
  `).all<AgentTokenRow>();

  const nowIso = new Date().toISOString();
  return (rows.results ?? []).map((row) => toAgentTokenSummary(row, nowIso));
}

export async function getAgentTokenById(
  db: D1Database,
  id: number,
): Promise<AgentTokenSummary | null> {
  const row = await db.prepare(`
    SELECT
      id, name, kind, token_hash, token_hint, scopes, prefixes, allow_plus_tags,
      recipient_policy, recipient_allowlist, send_limit_hour, send_limit_day,
      expires_at, revoked_at, last_used_at, last_used_ip, created_at, updated_at
    FROM agent_tokens
    WHERE id = ?
  `).bind(id).first<AgentTokenRow>();
  return row ? toAgentTokenSummary(row) : null;
}

export async function verifyAgentToken(
  db: D1Database,
  rawToken: string,
): Promise<AgentPrincipal | null> {
  if (!isAgentTokenFormat(rawToken)) return null;
  const tokenHash = await hashAgentToken(rawToken);
  const row = await db.prepare(`
    SELECT
      id, name, kind, token_hash, token_hint, scopes, prefixes, allow_plus_tags,
      recipient_policy, recipient_allowlist, send_limit_hour, send_limit_day,
      expires_at, revoked_at, last_used_at, last_used_ip, created_at, updated_at
    FROM agent_tokens
    WHERE token_hash = ?
  `).bind(tokenHash).first<AgentTokenRow>();

  if (!row) return null;
  if (row.revoked_at) return null;
  const nowIso = new Date().toISOString();
  if (row.expires_at && row.expires_at <= nowIso) return null;

  const summary = toAgentTokenSummary(row, nowIso);
  return {
    kind: 'agent',
    tokenId: summary.id,
    name: summary.name,
    scopes: summary.scopes,
    prefixes: summary.prefixes,
    allowPlusTags: summary.allow_plus_tags,
    recipientPolicy: summary.recipient_policy,
    recipientAllowlist: summary.recipient_allowlist,
    sendLimitHour: summary.send_limit_hour,
    sendLimitDay: summary.send_limit_day,
  };
}

export async function touchAgentTokenUsage(
  db: D1Database,
  tokenId: number,
  ipAddress: string,
): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - LAST_USED_THROTTLE_MS).toISOString();
  await db.prepare(`
    UPDATE agent_tokens
    SET last_used_at = ?, last_used_ip = ?
    WHERE id = ?
      AND (last_used_at IS NULL OR last_used_at < ?)
  `).bind(nowIso, ipAddress.slice(0, 64), tokenId, cutoffIso).run();
}

export async function revokeAgentToken(db: D1Database, id: number): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const result = await db.prepare(`
    UPDATE agent_tokens
    SET revoked_at = ?, updated_at = ?
    WHERE id = ? AND revoked_at IS NULL
  `).bind(nowIso, nowIso, id).run();
  return Number(result.meta.changes ?? 0) > 0;
}

export async function revokeAllAgentTokens(db: D1Database): Promise<number> {
  const nowIso = new Date().toISOString();
  const result = await db.prepare(`
    UPDATE agent_tokens
    SET revoked_at = ?, updated_at = ?
    WHERE revoked_at IS NULL
  `).bind(nowIso, nowIso).run();
  return Number(result.meta.changes ?? 0);
}

function parsePositiveInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  const num = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(num) || num < min || num > max) return null;
  return num;
}

function parseStringArray<T extends string>(raw: string): T[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is T => typeof item === 'string');
  } catch {
    return [];
  }
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
