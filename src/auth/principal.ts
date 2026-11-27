import type { AgentRecipientPolicy, AgentScope } from '../types';

export interface AdminPrincipal {
  kind: 'admin';
}

export interface AgentPrincipal {
  kind: 'agent';
  tokenId: number;
  name: string;
  scopes: AgentScope[];
  prefixes: string[];
  allowPlusTags: boolean;
  recipientPolicy: AgentRecipientPolicy;
  recipientAllowlist: string[];
  sendLimitHour: number;
  sendLimitDay: number;
}

export type Principal = AdminPrincipal | AgentPrincipal;

export interface PrefixSqlFilter {
  allowed: boolean;
  sql: string;
  params: unknown[];
}

export function hasScope(principal: Principal, scope: AgentScope): boolean {
  if (principal.kind === 'admin') return true;
  return principal.scopes.includes(scope);
}

export function hasWildcardPrefix(principal: Principal): boolean {
  if (principal.kind === 'admin') return true;
  return principal.prefixes.includes('*');
}

export function canReadPrefix(principal: Principal, emailPrefix: string): boolean {
  const target = emailPrefix.trim().toLowerCase();
  if (!target) return false;
  if (hasWildcardPrefix(principal)) return true;
  if (principal.kind !== 'agent') return true;

  for (const allowed of principal.prefixes) {
    if (target === allowed) return true;
    if (principal.allowPlusTags && !allowed.includes('+') && target.startsWith(`${allowed}+`)) {
      return true;
    }
  }
  return false;
}

export function canSendFromPrefix(principal: Principal, fromPrefix: string): boolean {
  const target = fromPrefix.trim().toLowerCase();
  if (!target || target === '*') return false;
  if (hasWildcardPrefix(principal)) return true;
  if (principal.kind !== 'agent') return true;
  return principal.prefixes.includes(target);
}

export function canSendToRecipient(principal: Principal, recipientEmail: string): boolean {
  const target = recipientEmail.trim().toLowerCase();
  if (!target) return false;
  if (principal.kind === 'admin' || principal.recipientPolicy === 'any') return true;

  for (const rawRule of principal.recipientAllowlist) {
    const rule = rawRule.trim().toLowerCase();
    if (!rule) continue;
    if (rule.startsWith('@')) {
      const at = target.lastIndexOf('@');
      if (at > 0 && target.slice(at) === rule) return true;
    } else if (target === rule) {
      return true;
    }
  }
  return false;
}

function prefixFamilyClause(
  column: string,
  prefix: string,
  includePlusTags: boolean,
): { sql: string; params: unknown[] } {
  if (includePlusTags && !prefix.includes('+')) {
    // '+' = 0x2B, ',' = 0x2C: binary range comparison stays index-friendly on (to_prefix, id DESC)
    // and avoids SQLite LIKE's case-insensitivity and '_' wildcard semantics.
    return {
      sql: `(${column} = ? OR (${column} >= ? AND ${column} < ?))`,
      params: [prefix, `${prefix}+`, `${prefix},`],
    };
  }
  return {
    sql: `${column} = ?`,
    params: [prefix],
  };
}

export function buildReadPrefixSqlFilter(
  principal: Principal,
  requestedPrefix?: string,
  column = 'to_prefix',
): PrefixSqlFilter {
  const normalizedRequest = requestedPrefix?.trim().toLowerCase() ?? '';

  if (normalizedRequest) {
    if (!canReadPrefix(principal, normalizedRequest)) {
      return { allowed: false, sql: '', params: [] };
    }
    const includePlus = principal.kind === 'agent'
      ? principal.allowPlusTags && !normalizedRequest.includes('+')
      : false;
    const clause = prefixFamilyClause(column, normalizedRequest, includePlus);
    return { allowed: true, sql: clause.sql, params: clause.params };
  }

  if (hasWildcardPrefix(principal)) {
    return { allowed: true, sql: '', params: [] };
  }

  if (principal.kind !== 'agent' || principal.prefixes.length === 0) {
    return { allowed: false, sql: '', params: [] };
  }

  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const prefix of principal.prefixes) {
    const clause = prefixFamilyClause(column, prefix, principal.allowPlusTags);
    clauses.push(clause.sql);
    params.push(...clause.params);
  }
  return {
    allowed: true,
    sql: clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`,
    params,
  };
}

export function buildSentPrefixSqlFilter(
  principal: Principal,
  requestedPrefix?: string,
  column = 'from_prefix',
): PrefixSqlFilter {
  const normalizedRequest = requestedPrefix?.trim().toLowerCase() ?? '';

  if (normalizedRequest) {
    if (!canSendFromPrefix(principal, normalizedRequest)) {
      return { allowed: false, sql: '', params: [] };
    }
    return { allowed: true, sql: `${column} = ?`, params: [normalizedRequest] };
  }

  if (hasWildcardPrefix(principal)) {
    return { allowed: true, sql: '', params: [] };
  }

  if (principal.kind !== 'agent' || principal.prefixes.length === 0) {
    return { allowed: false, sql: '', params: [] };
  }

  const placeholders = principal.prefixes.map(() => '?').join(', ');
  return {
    allowed: true,
    sql: `${column} IN (${placeholders})`,
    params: [...principal.prefixes],
  };
}
