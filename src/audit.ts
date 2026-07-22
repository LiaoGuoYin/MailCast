import type { AuditActor, AuditCategory, AuditStatus } from './types';

const RETENTION_DAYS = 90;
const MAX_ACTION_LENGTH = 80;
const MAX_TARGET_LENGTH = 160;
const MAX_SUMMARY_LENGTH = 500;
const MAX_DETAILS_LENGTH = 4000;
const MAX_IP_LENGTH = 64;
const MAX_DETAIL_STRING_LENGTH = 1000;
const SENSITIVE_DETAIL_KEY = /password|token|api[_-]?key|secret/i;

export interface AuditEvent {
  category: AuditCategory;
  action: string;
  status: AuditStatus;
  actor: AuditActor;
  targetType?: string;
  targetId?: string | number;
  summary: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  createdAt?: string;
}

export async function recordAuditLog(db: D1Database, event: AuditEvent): Promise<void> {
  const createdAt = event.createdAt ?? new Date().toISOString();
  await db.batch([
    db.prepare(`
      INSERT INTO audit_logs
        (category, action, status, actor, target_type, target_id,
         summary, details, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      event.category,
      bounded(event.action, MAX_ACTION_LENGTH),
      event.status,
      event.actor,
      bounded(event.targetType ?? '', MAX_TARGET_LENGTH),
      bounded(String(event.targetId ?? ''), MAX_TARGET_LENGTH),
      bounded(event.summary, MAX_SUMMARY_LENGTH),
      serializeDetails(event.details ?? {}),
      bounded(event.ipAddress ?? '', MAX_IP_LENGTH),
      createdAt,
    ),
    db.prepare(`
      DELETE FROM audit_logs
      WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${RETENTION_DAYS} days')
    `),
  ]);
}

export async function safeRecordAuditLog(db: D1Database, event: AuditEvent): Promise<void> {
  try {
    await recordAuditLog(db, event);
  } catch (error) {
    console.error(JSON.stringify({
      message: 'audit log write failed',
      action: event.action,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

export function requestIp(request: Request): string {
  return bounded(request.headers.get('CF-Connecting-IP')?.trim() ?? '', MAX_IP_LENGTH);
}

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function serializeDetails(details: Record<string, unknown>): string {
  const serialized = JSON.stringify(sanitizeValue(details, 0));
  if (serialized.length <= MAX_DETAILS_LENGTH) return serialized;
  return JSON.stringify({ truncated: true, preview: serialized.slice(0, MAX_DETAILS_LENGTH - 40) });
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 4) return '[omitted]';
  if (typeof value === 'string') return bounded(value, MAX_DETAIL_STRING_LENGTH);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SENSITIVE_DETAIL_KEY.test(key))
        .slice(0, 40)
        .map(([key, item]) => [key, sanitizeValue(item, depth + 1)]),
    );
  }
  return String(value ?? '');
}
