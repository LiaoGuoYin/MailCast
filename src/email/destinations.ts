import type { EmailDestination } from '../types';

export function normalizeDestinationId(value: unknown): number | null {
  const id = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function getEmailDestination(
  db: D1Database,
  id: number,
): Promise<EmailDestination | null> {
  return db.prepare(`
    SELECT d.id, d.name, d.email_address, d.created_at, d.updated_at,
           COUNT(r.id) AS rule_count
    FROM email_destinations d
    LEFT JOIN forward_rules r ON r.destination_id = d.id
    WHERE d.id = ?
    GROUP BY d.id
  `).bind(id).first<EmailDestination>();
}

export async function listEmailDestinations(db: D1Database): Promise<EmailDestination[]> {
  const result = await db.prepare(`
    SELECT d.id, d.name, d.email_address, d.created_at, d.updated_at,
           COUNT(r.id) AS rule_count
    FROM email_destinations d
    LEFT JOIN forward_rules r ON r.destination_id = d.id
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `).all<EmailDestination>();
  return result.results;
}
