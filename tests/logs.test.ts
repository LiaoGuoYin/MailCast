import { describe, expect, it, vi } from 'vitest';
import { recordAuditLog, requestIp } from '../src/audit';
import { logRoutes } from '../src/api/logs';

describe('audit log storage', () => {
  it('stores bounded metadata, removes secret fields, and prunes after 90 days', async () => {
    const statements: Array<{ query: string; values: unknown[] }> = [];
    const db = fakeBatchDatabase(statements);

    await recordAuditLog(db, {
      category: 'bot',
      action: 'bot.create',
      status: 'success',
      actor: 'admin',
      targetType: 'telegram_bot',
      targetId: 7,
      summary: '已添加 Telegram Bot “主通知”',
      details: {
        name: '主通知',
        token: 'must-not-be-stored',
        nested: { api_key: 'also-secret', username: 'inbox_bot' },
      },
      ipAddress: '203.0.113.8',
      createdAt: '2026-07-22T00:00:00.000Z',
    });

    const insert = statements.find(({ query }) => query.includes('INSERT INTO audit_logs'));
    expect(insert).toBeDefined();
    expect(JSON.stringify(insert?.values)).not.toContain('must-not-be-stored');
    expect(JSON.stringify(insert?.values)).not.toContain('also-secret');
    expect(JSON.stringify(insert?.values)).toContain('inbox_bot');
    expect(statements.some(({ query }) => query.includes("'-90 days'"))).toBe(true);
    expect(statements.some(({ query }) => query.includes("strftime('%Y-%m-%dT%H:%M:%fZ'")))
      .toBe(true);
  });

  it('uses only the Cloudflare client IP header', () => {
    const request = new Request('https://example.com', {
      headers: {
        'CF-Connecting-IP': '203.0.113.9',
        'User-Agent': 'not persisted',
      },
    });
    expect(requestIp(request)).toBe('203.0.113.9');
  });
});

describe('logs API', () => {
  it('filters and paginates logs while parsing structured details', async () => {
    const calls: Array<{ query: string; values: unknown[] }> = [];
    const db = {
      prepare: vi.fn((query: string) => ({
        bind: (...values: unknown[]) => {
          calls.push({ query, values });
          return {
            first: async () => ({ total: 31 }),
            all: async () => ({
              results: [{
                id: 9,
                category: 'delivery',
                action: 'delivery.forward.retry',
                status: 'failed',
                actor: 'admin',
                target_type: 'email_downstream',
                target_id: '12',
                summary: '再次触发邮件转发失败：me@example.com',
                details: '{"email_id":3,"attempt":2,"error":"timeout"}',
                ip_address: '203.0.113.10',
                created_at: '2026-07-22T00:00:00.000Z',
              }],
            }),
          };
        },
      })),
    };

    const response = await logRoutes.request(
      '/?page=2&limit=30&category=delivery&status=failed&q=timeout',
      {},
      { DB: db },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ total: 31, page: 2, limit: 30 });
    expect(body.data[0].details).toEqual({ email_id: 3, attempt: 2, error: 'timeout' });
    expect(calls[0].values).toEqual([
      'delivery', 'failed', '%timeout%', '%timeout%', '%timeout%', '%timeout%',
    ]);
    expect(calls[1].values.slice(-2)).toEqual([30, 30]);
  });

  it('rejects unknown categories and statuses', async () => {
    const db = { prepare: vi.fn() };
    const invalidCategory = await logRoutes.request('/?category=unknown', {}, { DB: db });
    const invalidStatus = await logRoutes.request('/?status=pending', {}, { DB: db });
    expect(invalidCategory.status).toBe(400);
    expect(invalidStatus.status).toBe(400);
    expect(db.prepare).not.toHaveBeenCalled();
  });
});

function fakeBatchDatabase(statements: Array<{ query: string; values: unknown[] }>): D1Database {
  const db = {
    prepare(query: string) {
      const record = { query, values: [] as unknown[] };
      statements.push(record);
      return {
        bind(...values: unknown[]) {
          record.values = values;
          return { query, values };
        },
      };
    },
    batch: vi.fn(async () => []),
  };
  return db as unknown as D1Database;
}
