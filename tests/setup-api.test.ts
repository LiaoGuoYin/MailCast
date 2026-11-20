import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveSetupStatus, setupRoutes } from '../src/api/setup';
import { settingsRoutes } from '../src/api/settings';
import type { Env } from '../src/types';

const EMPTY = { latest_to_addr: null, forward_rules: 0, telegram_rules: 0, bark_rules: 0 };

describe('onboarding status', () => {
  it('is incomplete on a fresh install and does not demand sending setup', () => {
    const status = deriveSetupStatus(EMPTY, { provider: 'resend', configured: false });
    expect(status).toMatchObject({
      receiving: { done: false, domain: '' },
      rules: { done: false, count: 0 },
      sending: { done: false, required: false },
      complete: false,
    });
  });

  it('completes for a Telegram-only setup without any sending configuration', () => {
    const status = deriveSetupStatus(
      { ...EMPTY, latest_to_addr: 'otp@Mail.Example.com', telegram_rules: 1 },
      { provider: 'resend', configured: false },
    );
    expect(status.receiving).toEqual({ done: true, domain: 'mail.example.com' });
    expect(status.sending.required).toBe(false);
    expect(status.complete).toBe(true);
  });

  it('stays incomplete while a forward rule has no sending service behind it', () => {
    const counts = { ...EMPTY, latest_to_addr: 'a@example.com', forward_rules: 1 };
    expect(deriveSetupStatus(counts, { provider: 'resend', configured: false }).complete)
      .toBe(false);
    expect(deriveSetupStatus(counts, { provider: 'resend', configured: true }).complete)
      .toBe(true);
  });

  it('treats Cloudflare sending as configured only when the EMAIL binding exists', async () => {
    const db = fakeDb({
      settings: { email_provider: 'cloudflare' },
      counts: { ...EMPTY, latest_to_addr: 'a@example.com', forward_rules: 2 },
    });
    const without = await setupRoutes.request('/', {}, { DB: db } as Env);
    expect((await without.json<{ sending: unknown }>()).sending)
      .toEqual({ done: false, required: true, provider: 'cloudflare' });

    const withBinding = await setupRoutes.request('/', {}, { DB: db, EMAIL: {} } as unknown as Env);
    expect((await withBinding.json<{ complete: boolean }>()).complete).toBe(true);
  });
});

describe('test email', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects an invalid recipient before touching the provider', async () => {
    const response = await sendTest(fakeDb({}), 'not-an-address');
    expect(response.status).toBe(400);
  });

  it('explains that sending is not configured yet', async () => {
    const response = await sendTest(fakeDb({}), 'me@example.net');
    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toContain('API Key');
  });

  it('asks for a sender address when there is neither a setting nor a received mail', async () => {
    const db = fakeDb({ settings: { resend_api_key: 're_example_1234' } });
    const response = await sendTest(db, 'me@example.net');
    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toContain('发件地址');
  });

  it('sends from the receiving domain and records the outcome', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ id: 'msg_1' }));
    vi.stubGlobal('fetch', fetcher);
    const db = fakeDb({
      settings: { resend_api_key: 're_example_1234' },
      latestTo: 'github@mail.example.com',
    });

    const response = await sendTest(db, 'me@example.net');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      from_address: 'forwarder@mail.example.com',
    });
    const sent = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(sent).toMatchObject({ from: 'MailCast <forwarder@mail.example.com>', to: 'me@example.net' });
    expect(db.statements.some((s) => s.query.includes('INSERT INTO audit_logs')
      && s.values.includes('success'))).toBe(true);
  });

  it('surfaces the provider error so the customer can fix the domain', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(
      { name: 'validation_error', message: 'The example.com domain is not verified' },
      { status: 403 },
    )));
    const db = fakeDb({
      settings: { resend_api_key: 're_example_1234', email_from_address: 'x@example.com' },
    });

    const response = await sendTest(db, 'me@example.net');
    expect(response.status).toBe(502);
    const body = await response.json<{ error: string; from_address: string }>();
    expect(body.error).toBe('发送失败：The example.com domain is not verified');
    expect(body.from_address).toBe('x@example.com');
  });
});

function sendTest(db: ReturnType<typeof fakeDb>, to: string) {
  return settingsRoutes.request('/email-sender/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to }),
  }, { DB: db } as unknown as Env);
}

function fakeDb(options: {
  settings?: Record<string, string>;
  counts?: typeof EMPTY | (Omit<typeof EMPTY, 'latest_to_addr'> & { latest_to_addr: string });
  latestTo?: string;
}) {
  const statements: Array<{ query: string; values: unknown[] }> = [];
  const first = (query: string, values: unknown[]) => {
    if (query.includes('SELECT value FROM settings')) {
      const value = options.settings?.[String(values[0])];
      return value === undefined ? null : { value };
    }
    if (query.includes('AS latest_to_addr')) return options.counts ?? EMPTY;
    if (query.includes('SELECT to_addr FROM emails')) {
      return options.latestTo ? { to_addr: options.latestTo } : null;
    }
    return null;
  };
  const statement = (query: string, values: unknown[]) => {
    const record = { query, values };
    statements.push(record);
    return {
      bind: (...bound: unknown[]) => statement(query, bound),
      first: async () => first(query, values),
      run: async () => ({ success: true, meta: { changes: 1, last_row_id: 1 } }),
    };
  };
  return {
    prepare: (query: string) => statement(query, []),
    batch: async () => [],
    statements,
  };
}
