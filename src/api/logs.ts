import { Hono } from 'hono';
import type { AuditCategory, AuditLog, AuditStatus, Env } from '../types';

export const logRoutes = new Hono<{ Bindings: Env }>();

const CATEGORIES: AuditCategory[] = ['delivery', 'auth', 'bot', 'rule', 'settings', 'email'];
const STATUSES: AuditStatus[] = ['success', 'failed', 'info'];

interface AuditLogRow extends Omit<AuditLog, 'details'> {
  details: string;
}

logRoutes.get('/', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 30));
  const category = c.req.query('category') ?? '';
  const status = c.req.query('status') ?? '';
  const query = (c.req.query('q') ?? '').trim().slice(0, 100);

  if (category && !CATEGORIES.includes(category as AuditCategory)) {
    return c.json({ error: 'Invalid log category' }, 400);
  }
  if (status && !STATUSES.includes(status as AuditStatus)) {
    return c.json({ error: 'Invalid log status' }, 400);
  }

  const filters: string[] = [];
  const params: unknown[] = [];
  if (category) {
    filters.push('category = ?');
    params.push(category);
  }
  if (status) {
    filters.push('status = ?');
    params.push(status);
  }
  if (query) {
    filters.push('(summary LIKE ? OR action LIKE ? OR target_id LIKE ? OR details LIKE ?)');
    const like = `%${query}%`;
    params.push(like, like, like, like);
  }

  const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  const offset = (page - 1) * limit;
  const [count, result] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM audit_logs${where}`)
      .bind(...params)
      .first<{ total: number }>(),
    c.env.DB.prepare(`
      SELECT id, category, action, status, actor, target_type, target_id,
             summary, details, ip_address, created_at
      FROM audit_logs${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).bind(...params, limit, offset).all<AuditLogRow>(),
  ]);

  return c.json({
    data: result.results.map((row) => ({ ...row, details: parseDetails(row.details) })),
    total: count?.total ?? 0,
    page,
    limit,
  });
});

function parseDetails(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
