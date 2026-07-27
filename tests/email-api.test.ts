import { describe, expect, it, vi } from 'vitest';
import { emailRoutes, normalizeEmailDetail } from '../src/api/emails';
import type { Env } from '../src/types';

const baseEmail = {
  id: 1,
  from_addr: 'sender@example.com',
  to_addr: 'inbox@example.com',
  to_prefix: 'inbox',
  subject: 'Hello',
  text_body: 'Plain text',
  html_body: '<p>HTML</p>',
  body_truncated: 0,
  raw_body: 'Subject: Hello\r\n\r\nPlain text',
  raw_truncated: 0,
  downstream_recorded: 1,
  is_read: 0,
  created_at: '2026-07-21T00:00:00.000Z',
};

describe('email detail', () => {
  it('returns stored bodies and normalizes numeric flags', () => {
    const detail = normalizeEmailDetail({
      ...baseEmail,
      body_truncated: 1,
      raw_truncated: 1,
      downstream_recorded: 0,
    });

    expect(detail.text_body).toBe('Plain text');
    expect(detail.html_body).toBe('<p>HTML</p>');
    expect(detail.body_truncated).toBe(true);
    expect(detail.raw_body).toContain('Subject: Hello');
    expect(detail.raw_truncated).toBe(true);
    expect(detail.downstream_recorded).toBe(false);
    expect(detail.is_read).toBe(false);
  });
});

describe('email read state', () => {
  it('returns the global unread count and normalizes row read flags', async () => {
    const database = fakeEmailDatabase({
      total: 3,
      unreadCount: 2,
      rows: [
        {
          id: 3,
          from_addr: 'new@example.com',
          to_addr: 'inbox@example.com',
          to_prefix: 'inbox',
          subject: 'New',
          body_preview: 'Unread',
          is_read: 0,
          created_at: '2026-07-27T00:00:00.000Z',
        },
      ],
    });

    const response = await emailRoutes.request('/?page=1&limit=20', {}, {
      DB: database.db,
    } as Env);
    const body = await response.json<{
      data: Array<{ is_read: boolean }>;
      total: number;
      unread_count: number;
    }>();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ total: 3, unread_count: 2 });
    expect(body.data[0].is_read).toBe(false);
  });

  it('marks an email as read idempotently and returns the remaining count', async () => {
    const database = fakeEmailDatabase({
      emailId: 8,
      unreadCount: 1,
    });

    const response = await emailRoutes.request('/8/read', {
      method: 'PATCH',
    }, { DB: database.db } as Env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      unread_count: 1,
    });
    expect(database.statements).toContainEqual(expect.objectContaining({
      query: expect.stringContaining('UPDATE emails SET is_read = 1'),
      values: ['8'],
    }));
  });

  it('returns the unread count without loading inbox rows', async () => {
    const database = fakeEmailDatabase({ unreadCount: 7 });
    const response = await emailRoutes.request('/unread-count', {}, {
      DB: database.db,
    } as Env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ unread_count: 7 });
    expect(database.statements).toHaveLength(1);
  });

  it('does not update a missing email', async () => {
    const database = fakeEmailDatabase({ emailId: null, unreadCount: 0 });
    const response = await emailRoutes.request('/404/read', {
      method: 'PATCH',
    }, { DB: database.db } as Env);

    expect(response.status).toBe(404);
    expect(database.statements.some(({ query }) => query.includes('UPDATE emails')))
      .toBe(false);
  });
});

function fakeEmailDatabase(options: {
  total?: number;
  unreadCount: number;
  rows?: Record<string, unknown>[];
  emailId?: number | null;
}) {
  const statements: Array<{ query: string; values: unknown[] }> = [];
  const db = {
    prepare: vi.fn((query: string) => {
      const record = { query, values: [] as unknown[] };
      statements.push(record);
      const statement = {
        bind: (...values: unknown[]) => {
          record.values = values;
          return statement;
        },
        first: async () => {
          if (query.includes('SELECT id FROM emails')) {
            return options.emailId == null ? null : { id: options.emailId };
          }
          if (query.includes('WHERE is_read = 0')) {
            return { total: options.unreadCount };
          }
          return { total: options.total ?? 0 };
        },
        all: async () => ({ results: options.rows ?? [] }),
        run: async () => ({ meta: { changes: 1 } }),
      };
      return statement;
    }),
  };
  return { db: db as unknown as D1Database, statements };
}
