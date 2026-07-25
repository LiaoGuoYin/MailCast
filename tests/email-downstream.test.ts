import { afterEach, describe, expect, it, vi } from 'vitest';
import { emailRoutes } from '../src/api/emails';
import {
  claimDownstreamRetry,
  createDownstream,
  deliverStoredDownstream,
  downstreamErrorDetails,
  settleDownstream,
} from '../src/email/downstream';
import { TelegramApiError } from '../src/telegram/notify';

const storedEmail = {
  id: 12,
  from_addr: 'sender@example.com',
  to_addr: 'inbox@example.com',
  to_prefix: 'inbox',
  subject: 'Status report',
  text_body: 'Stored body',
  html_body: '<p>Stored body</p>',
  body_truncated: 0,
  raw_body: '',
  raw_truncated: 0,
  downstream_recorded: 1,
  created_at: '2026-07-22T00:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('email downstream tracking', () => {
  it('creates a pending downstream record with the first attempt counted', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { last_row_id: 41 } });
    const bind = vi.fn(() => ({ run }));
    const db = { prepare: vi.fn(() => ({ bind })) };

    const id = await createDownstream(db, {
      emailId: 12,
      channel: 'telegram',
      source: 'rule',
      ruleId: 8,
      target: '-100123',
    });

    expect(id).toBe(41);
    expect(bind).toHaveBeenCalledWith(
      12,
      'telegram',
      'rule',
      8,
      '-100123',
      null,
      '',
      null,
      '',
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it('stores a bounded downstream failure description', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const bind = vi.fn(() => ({ run }));
    const db = { prepare: vi.fn(() => ({ bind })) };

    await settleDownstream(db, 41, 1, new Error('x'.repeat(1200)));

    expect(bind.mock.calls[0][0]).toBe('failed');
    expect(bind.mock.calls[0][1]).toHaveLength(1000);
    expect(bind.mock.calls[0][4]).toBe(1);
  });

  it('does not let an older attempt overwrite a newer retry', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 0 } });
    const db = { prepare: vi.fn(() => ({ bind: () => ({ run }) })) };

    await expect(settleDownstream(db, 41, 1, null)).resolves.toBe(false);
  });

  it('exposes Telegram API errors without including the Bot Token', () => {
    const result = downstreamErrorDetails(new TelegramApiError(
      400,
      'Bad Request: chat not found',
      400,
    ));

    expect(result).toEqual({
      code: 'TELEGRAM_400',
      description: 'Bad Request: chat not found',
    });
    expect(JSON.stringify(result).toLowerCase()).not.toContain('token');
  });

  it('reports a retry conflict when another attempt owns the pending state', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 0 } });
    const db = { prepare: vi.fn(() => ({ bind: () => ({ run }) })) };

    await expect(claimDownstreamRetry(db, 12, 41)).resolves.toBe(false);
  });

  it('re-sends a stored email through the fixed Email binding sender', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'retry-message' });
    const messageId = await deliverStoredDownstream({
      DB: settingsDatabase(null),
      EMAIL: { send },
      EMAIL_FROM_ADDRESS: 'forwarder@example.com',
    }, {
      ...storedEmail,
      body_truncated: false,
    }, {
      channel: 'forward',
      target: 'next@example.com',
    });

    expect(messageId).toBe('retry-message');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'next@example.com',
      from: { email: 'forwarder@example.com', name: 'MailCast' },
      subject: 'Fwd: Status report',
    }));
  });

  it('defaults the sender to forwarder at the receiving domain', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'default-sender' });
    await deliverStoredDownstream({
      DB: settingsDatabase(null),
      EMAIL: { send },
    }, {
      ...storedEmail,
      to_addr: 'alerts@Mail.Example.COM',
      body_truncated: false,
    }, {
      channel: 'forward',
      target: 'next@example.com',
    });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      from: { email: 'forwarder@mail.example.com', name: 'MailCast' },
    }));
  });

  it('prefers the web sender setting over the environment override', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'web-sender' });
    await deliverStoredDownstream({
      DB: settingsDatabase('notify@configured.example'),
      EMAIL: { send },
      EMAIL_FROM_ADDRESS: 'forwarder@environment.example',
    }, {
      ...storedEmail,
      body_truncated: false,
    }, {
      channel: 'forward',
      target: 'next@example.com',
    });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      from: { email: 'notify@configured.example', name: 'MailCast' },
    }));
  });

  it('explains when optional Email Sending has not been configured', async () => {
    await expect(deliverStoredDownstream({}, {
      ...storedEmail,
      body_truncated: false,
    }, {
      channel: 'forward',
      target: 'next@example.com',
    })).rejects.toThrow('邮件转发尚未配置');
  });

  it('returns tracked downstream rows and derives stale pending state', async () => {
    const prepare = vi.fn((query: string) => ({
      bind: () => ({
        first: vi.fn().mockResolvedValue({ downstream_recorded: 1 }),
        all: vi.fn().mockResolvedValue({
          results: [{
            id: 41,
            email_id: 12,
            channel: 'forward',
            source: 'rule',
            rule_id: 3,
            target: 'next@example.com',
            status: 'pending',
            attempt_count: 1,
            last_error: '',
            last_triggered_at: '2026-07-22T00:00:00.000Z',
            created_at: '2026-07-22T00:00:00.000Z',
            updated_at: '2026-07-22T00:00:00.000Z',
            is_stale: query.includes('julianday') ? 1 : 0,
          }],
        }),
      }),
    }));

    const response = await emailRoutes.request('/12/downstreams', {}, { DB: { prepare } });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.tracked).toBe(true);
    expect(body.data[0]).toMatchObject({ id: 41, is_stale: true });
  });

  it('retries the original downstream target and settles it as successful', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'retry-2' });
    const first = vi.fn().mockResolvedValue({
      ...storedEmail,
      downstream_id: 41,
      downstream_email_id: 12,
      channel: 'forward',
      source: 'rule',
      rule_id: 3,
      target: 'next@example.com',
      status: 'failed',
      attempt_count: 1,
      last_error: 'temporary error',
      last_triggered_at: '2026-07-22T00:00:00.000Z',
      downstream_created_at: '2026-07-22T00:00:00.000Z',
      downstream_updated_at: '2026-07-22T00:00:00.000Z',
    });
    const run = vi.fn()
      .mockResolvedValueOnce({ meta: { changes: 1 } })
      .mockResolvedValueOnce({ meta: { changes: 1 } });
    const prepare = vi.fn(() => ({ bind: () => ({ first, run }) }));

    const response = await emailRoutes.request('/12/downstreams/41/retry', {
      method: 'POST',
    }, {
      DB: { prepare },
      EMAIL: { send },
      EMAIL_FROM_ADDRESS: 'forwarder@example.com',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'next@example.com' }));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('creates and executes a manual Telegram downstream with the selected Bot', async () => {
    const statements: Array<{ query: string; args: unknown[] }> = [];
    const bot = {
      id: 7,
      name: '验证码通知',
      token: 'stored-bot-token',
      token_hint: 'oken',
      username: 'code_bot',
      telegram_user_id: '700',
      created_at: '2026-07-22T00:00:00.000Z',
      updated_at: '2026-07-22T00:00:00.000Z',
    };
    const prepare = vi.fn((query: string) => ({
      bind: (...args: unknown[]) => {
        statements.push({ query, args });
        return {
          first: vi.fn().mockImplementation(async () => {
            if (query.includes('FROM telegram_bots')) return bot;
            if (query.includes('FROM emails')) return storedEmail;
            if (query.includes('SELECT value FROM settings')) return null;
            return null;
          }),
          run: vi.fn().mockResolvedValue({
            meta: {
              last_row_id: query.includes('INSERT INTO email_downstreams') ? 55 : 0,
              changes: 1,
            },
          }),
        };
      },
    }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, result: { message_id: 1 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const response = await emailRoutes.request('/12/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: '7', chat_id: '-100123' }),
    }, { DB: { prepare } });

    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody).toEqual({ success: true, downstream_id: 55 });
    const insert = statements.find(({ query }) => query.includes('INSERT INTO email_downstreams'));
    expect(insert?.args.slice(0, 7)).toEqual([
      12,
      'telegram',
      'quick_forward',
      null,
      '-100123',
      7,
      '验证码通知',
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.telegram.org/botstored-bot-token/sendMessage',
    );
    expect(JSON.stringify(responseBody)).not.toContain('stored-bot-token');
  });

  it('rejects a malformed manual Telegram target before delivery', async () => {
    const prepare = vi.fn();
    const response = await emailRoutes.request('/12/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot_id: '7', chat_id: '@channel' }),
    }, { DB: { prepare } });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Chat ID 应为纯数字（群组为负数）' });
    expect(prepare).not.toHaveBeenCalled();
  });
});

function settingsDatabase(value: string | null) {
  return {
    prepare: vi.fn(() => ({
      bind: () => ({
        first: vi.fn().mockResolvedValue(value === null ? null : { value }),
      }),
    })),
  };
}
