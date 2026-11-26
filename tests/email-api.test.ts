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

  it('supports unread-only filtering and returns clean CSS-free snippets', async () => {
    const database = fakeEmailDatabase({
      total: 1,
      unreadCount: 1,
      rows: [
        {
          id: 9,
          from_addr: 'notification@bnesim.com',
          to_addr: 'i@example.com',
          to_prefix: 'i',
          subject: 'Thanks, your eSIM is ready',
          text_preview: '*{box-sizing: border-box;} @media (max-width:620px){.a{display:none;}}',
          html_preview: '<style>body{margin:0;}</style><p>Your Japan 5GB eSIM is ready to install.</p>',
          is_read: 0,
          created_at: '2026-07-27T00:00:00.000Z',
        },
      ],
    });

    const response = await emailRoutes.request('/?page=1&limit=20&unread=1', {}, {
      DB: database.db,
    } as Env);
    const body = await response.json<{
      data: Array<{ snippet: string; body_preview: string; is_read: boolean }>;
    }>();

    expect(response.status).toBe(200);
    expect(body.data[0].snippet).toBe('Your Japan 5GB eSIM is ready to install.');
    expect(body.data[0].body_preview).not.toContain('box-sizing');
    expect(database.statements.some(({ query }) => query.includes('is_read = 0'))).toBe(true);
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
  it('returns reply_to_addr parsed from raw headers and linked replies on detail fetch', async () => {
    const database = fakeEmailDatabase({
      unreadCount: 0,
      emailRow: {
        ...baseEmail,
        from_addr: 'bounces+verp@notify.github.com',
        raw_body: [
          'From: Octocat <octocat@github.com>',
          'Reply-To: reply+123@reply.github.com',
          'Message-ID: <issue-1@github.com>',
          'Subject: Hello',
          '',
          'Plain text',
        ].join('\r\n'),
      },
      replies: [
        {
          id: 5,
          from_prefix: 'inbox',
          from_addr: 'inbox@example.com',
          to_addr: 'reply+123@reply.github.com',
          reply_to: '',
          subject: 'Re: Hello',
          text_body: 'Looks good!',
          reply_to_email_id: 1,
          provider: 'resend',
          provider_message_id: 're_123',
          status: 'success',
          error: '',
          created_at: '2026-07-28T00:00:00.000Z',
        },
      ],
    });

    const response = await emailRoutes.request('/1', {}, { DB: database.db } as Env);
    const body = await response.json<{
      reply_to_addr: string;
      replies: Array<{ id: number; status: string }>;
    }>();

    expect(response.status).toBe(200);
    expect(body.reply_to_addr).toBe('reply+123@reply.github.com');
    expect(body.replies).toHaveLength(1);
    expect(body.replies[0]).toMatchObject({ id: 5, status: 'success' });
  });
});

function fakeEmailDatabase(options: {
  total?: number;
  unreadCount: number;
  rows?: Record<string, unknown>[];
  emailId?: number | null;
  emailRow?: Record<string, unknown> | null;
  replies?: Record<string, unknown>[];
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
          if (query.includes('FROM emails') && query.includes('raw_body')) {
            return options.emailRow ?? null;
          }
          if (query.includes('SELECT id FROM emails')) {
            return options.emailId == null ? null : { id: options.emailId };
          }
          if (query.includes('WHERE is_read = 0')) {
            return { total: options.unreadCount };
          }
          return { total: options.total ?? 0 };
        },
        all: async () => {
          if (query.includes('FROM sent_emails')) {
            return { results: options.replies ?? [] };
          }
          return { results: options.rows ?? [] };
        },
        run: async () => ({ meta: { changes: 1 } }),
      };
      return statement;
    }),
  };
  return { db: db as unknown as D1Database, statements };
}
