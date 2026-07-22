import type { BarkEndpoint, BarkEndpointSummary } from '../types';

export function normalizeBarkEndpointId(value: unknown): number | null {
  const id = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function getBarkEndpoint(
  db: D1Database,
  id: number,
): Promise<BarkEndpoint | null> {
  return db.prepare('SELECT * FROM bark_endpoints WHERE id = ?').bind(id).first<BarkEndpoint>();
}

export async function listBarkEndpoints(db: D1Database): Promise<BarkEndpointSummary[]> {
  const result = await db.prepare(`
    SELECT e.id, e.name, e.server_url, e.key_hint, e.created_at, e.updated_at,
           COUNT(r.id) AS rule_count
    FROM bark_endpoints e
    LEFT JOIN bark_rules r ON r.endpoint_id = e.id
    GROUP BY e.id
    ORDER BY e.created_at DESC
  `).all<BarkEndpointSummary>();
  return result.results;
}
