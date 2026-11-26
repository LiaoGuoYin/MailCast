import { afterEach, describe, expect, it, vi } from 'vitest';
import { outboundRoutes } from '../src/api/outbound';
import { buildReplyHeaders, parseReplyMetadata, replySubject } from '../src/email/reply';
import type { Env } from '../src/types';

describe('reply header parsing', () => {
  it('prefers header Reply-To over From and envelope sender, and chains References', async () => {
    const raw = [
      'From: Alice <alice@example.org>',
      'Reply-To: Support Team <support@example.org>',
      'Message-ID: <msg-2@example.org>',
      'References: <msg-1@example.org>',
      'Subject: Help',
      '',
      'Body content here',
    ].join('\r\n');

    const meta = await parseReplyMetadata(raw, 'bounces+123@mailer.example.org');
    expect(meta).toEqual({
      replyAddress: 'support@example.org',
      messageId: '<msg-2@example.org>',
      references: '<msg-1@example.org>',
    });
    expect(buildReplyHeaders(meta)).toEqual({
      'In-Reply-To': '<msg-2@example.org>',
      References: '<msg-1@example.org> <msg-2@example.org>',
    });
  });

  it('falls back to header From and then envelope sender when Reply-To is absent', async () => {
    const rawWithFrom = 'From: Bob <bob@example.org>\r\nSubject: Hi\r\n\r\nHi';
    const meta1 = await parseReplyMetadata(rawWithFrom, 'bounce@example.org');
    expect(meta1.replyAddress).toBe('bob@example.org');
    expect(buildReplyHeaders(meta1)).toBeUndefined();

    const meta2 = await parseReplyMetadata('', 'fallback@example.org');
    expect(meta2.replyAddress).toBe('fallback@example.org');
  });

  it('formats Re: subjects without duplicating prefixes', () => {
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject('Re: Hello')).toBe('Re: Hello');
    expect(replySubject('re:  Hello')).toBe('re:  Hello');
    expect(replySubject('')).toBe('Re: （无主题）');
  });
});

describe('outbound API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns outbound context with domains and filtered prefix suggestions', async () => {
    const db = fakeOutboundDb({
      settings: {
        email_provider: 'resend',
        resend_api_key: 're_secret',
        email_from_address: 'forwarder@mail.example.com',
      },
      latestToAddr: 'github@example.com',
      prefixes: ['github', '*', 'hi', 'bad..prefix'],
    });

    const response = await outboundRoutes.request('/context', {}, { DB: db.db } as Env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      configured: true,
      provider: 'resend',
      send_domain: 'mail.example.com',
      receive_domain: 'example.com',
      prefixes: ['github', 'hi'],
    });
  });

  it('rejects wildcard prefix, invalid recipient, and missing body', async () => {
    const db = fakeOutboundDb({
      settings: { email_provider: 'resend', resend_api_key: 're_secret' },
    });

    const r1 = await outboundRoutes.request('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: '*', to: 'a@b.com', subject: 'Hi', text: 'Body' }),
    }, { DB: db.db } as Env);
    expect(r1.status).toBe(400);

    const r2 = await outboundRoutes.request('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: 'hi', to: 'not-an-email', subject: 'Hi', text: 'Body' }),
    }, { DB: db.db } as Env);
    expect(r2.status).toBe(400);

    const r3 = await outboundRoutes.request('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: 'hi', to: 'a@b.com', subject: 'Hi', text: '   ' }),
    }, { DB: db.db } as Env);
    expect(r3.status).toBe(400);
  });

  it('sends a composed email via Resend, omits Reply-To on same domain, and records sent_emails + audit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: 're_msg_1' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const db = fakeOutboundDb({
      settings: {
        email_provider: 'resend',
        resend_api_key: 're_secret',
        email_from_address: 'forwarder@example.com',
      },
      latestToAddr: 'hi@example.com',
    });

    const response = await outboundRoutes.request('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prefix: 'Hi',
        to: 'friend@example.net',
        subject: 'Quick note\r\nInjected: bad',
        text: 'Hello from MailCast!',
      }),
    }, { DB: db.db } as Env);

    expect(response.status).toBe(200);
    const body = await response.json<{
      success: boolean;
      id: number;
      from: string;
      reply_to: string;
      message_id: string;
    }>();
    expect(body).toMatchObject({
      success: true,
      id: 42,
      from: 'hi@example.com',
      reply_to: '',
      message_id: 're_msg_1',
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      from: 'hi <hi@example.com>',
      to: 'friend@example.net',
      subject: 'Quick note Injected: bad',
      text: 'Hello from MailCast!',
    });
    expect(db.sentInserts).toHaveLength(1);
    expect(db.sentInserts[0]).toMatchObject({
      from_prefix: 'hi',
      from_addr: 'hi@example.com',
      status: 'success',
    });
    expect(db.auditActions).toContain('email.send');
  });

  it('sends a cross-domain reply with In-Reply-To, References, and Reply-To', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: 're_reply_1' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const db = fakeOutboundDb({
      settings: {
        email_provider: 'resend',
        resend_api_key: 're_secret',
        email_from_address: 'forwarder@mail.example.com',
      },
      replyEmail: {
        id: 7,
        from_addr: 'bounce@github.com',
        to_addr: 'github@example.com',
        to_prefix: 'github',
        raw_body: [
          'From: GitHub <notifications@github.com>',
          'Message-ID: <gh-7@github.com>',
          'References: <gh-1@github.com>',
          '',
          'Original message',
        ].join('\r\n'),
      },
    });

    const response = await outboundRoutes.request('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prefix: 'github',
        to: 'notifications@github.com',
        subject: 'Re: PR #7',
        text: 'LGTM!',
        reply_to_email_id: 7,
      }),
    }, { DB: db.db } as Env);

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      from: 'github <github@mail.example.com>',
      to: 'notifications@github.com',
      reply_to: 'github@example.com',
      subject: 'Re: PR #7',
      text: 'LGTM!',
      headers: {
        'In-Reply-To': '<gh-7@github.com>',
        References: '<gh-1@github.com> <gh-7@github.com>',
      },
    });
    expect(db.sentInserts[0]).toMatchObject({
      reply_to_email_id: 7,
      reply_to: 'github@example.com',
      status: 'success',
    });
    expect(db.auditActions).toContain('email.reply');
  });

  it('records failed sent_emails row and returns 502 on provider error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ name: 'validation_error', message: 'The domain is not verified' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const db = fakeOutboundDb({
      settings: {
        email_provider: 'resend',
        resend_api_key: 're_secret',
        email_from_address: 'forwarder@example.com',
      },
    });

    const response = await outboundRoutes.request('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prefix: 'hi',
        to: 'friend@example.net',
        subject: 'Test',
        text: 'Hello',
      }),
    }, { DB: db.db } as Env);

    expect(response.status).toBe(502);
    const body = await response.json<{ error: string; email: { description: string }; sent: { status: string } }>();
    expect(body.error).toBe('邮件发送失败');
    expect(body.email.description).toContain('not verified');
    expect(body.sent.status).toBe('failed');
    expect(db.sentInserts[0]).toMatchObject({ status: 'failed' });
  });
});

function fakeOutboundDb(options: {
  settings?: Record<string, string>;
  latestToAddr?: string;
  prefixes?: string[];
  replyEmail?: {
    id: number;
    from_addr: string;
    to_addr: string;
    to_prefix: string;
    raw_body: string;
  } | null;
}) {
  const settings = options.settings ?? {};
  const sentInserts: Array<Record<string, unknown>> = [];
  const auditActions: string[] = [];

  const db = {
    prepare: vi.fn((query: string) => {
      let bound: unknown[] = [];
      const statement = {
        bind: (...values: unknown[]) => {
          bound = values;
          return statement;
        },
        first: async () => {
          if (query.includes('FROM settings')) {
            const key = String(bound[0] ?? '');
            return Object.hasOwn(settings, key) ? { value: settings[key] } : null;
          }
          if (query.includes('SELECT to_addr FROM emails')) {
            return options.latestToAddr ? { to_addr: options.latestToAddr } : null;
          }
          if (query.includes('FROM emails WHERE id = ?')) {
            return options.replyEmail ?? null;
          }
          return null;
        },
        all: async () => {
          if (query.includes('SELECT prefix FROM')) {
            return { results: (options.prefixes ?? []).map((prefix) => ({ prefix })) };
          }
          return { results: [] };
        },
        run: async () => {
          if (query.includes('INSERT INTO sent_emails')) {
            sentInserts.push({
              from_prefix: bound[0],
              from_addr: bound[1],
              to_addr: bound[2],
              reply_to: bound[3],
              subject: bound[4],
              text_body: bound[5],
              reply_to_email_id: bound[6],
              provider: bound[7],
              provider_message_id: bound[8],
              status: bound[9],
              error: bound[10],
            });
            return { meta: { last_row_id: 42 } };
          }
          if (query.includes('INSERT INTO audit_logs')) {
            auditActions.push(String(bound[1] ?? ''));
          }
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    }),
    batch: vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) => {
      for (const stmt of statements) await stmt.run();
      return [];
    }),
  };

  return { db: db as unknown as D1Database, sentInserts, auditActions };
}
