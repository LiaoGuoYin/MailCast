import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware, authRoutes, DEFAULT_INITIAL_PASSWORD } from '../src/api/auth';
import { hashSessionToken } from '../src/auth/session';
import { hashAuthToken, verifyAuthToken } from '../src/auth/token';
import { mailDomainFromAddress, settingsRoutes } from '../src/api/settings';
import type { Env } from '../src/types';

const PASSWORD = 'correct-horse-42';
const SESSION_TOKEN = 'a'.repeat(43);
let passwordHash = '';
let sessionHash = '';

beforeAll(async () => {
  passwordHash = await hashAuthToken(PASSWORD);
  sessionHash = await hashSessionToken(SESSION_TOKEN);
});

describe('admin authentication', () => {
  it('extracts the configured receiving domain for the rules UI', () => {
    expect(mailDomainFromAddress(' forwarder@Example.COM ')).toBe('example.com');
    expect(mailDomainFromAddress('invalid-address')).toBe('');
  });

  it('exposes the effective sender configuration for the settings UI', async () => {
    const database = fakeDatabase({});
    const response = await settingsRoutes.request('/', {}, {
      DB: database.db,
      EMAIL_FROM_ADDRESS: 'forwarder@mail.example.com',
    } as unknown as Env);

    expect(response.status).toBe(200);
    const body = await response.json<{
      mail_domain: string;
      email_sender: {
        environment_address: string;
        configured_address: string;
        source: string;
        binding_configured: boolean;
        provider: string;
        resend_configured: boolean;
        resend_key_hint: string;
      };
    }>();
    expect(body.mail_domain).toBe('mail.example.com');
    expect(body.email_sender).toEqual({
      environment_address: 'forwarder@mail.example.com',
      configured_address: '',
      source: 'environment',
      binding_configured: false,
      provider: 'resend',
      resend_configured: false,
      resend_key_hint: '',
    });
  });

  it('exposes only a hint for the stored Resend API Key', async () => {
    const database = fakeDatabase({
      settings: {
        email_provider: 'resend',
        resend_api_key: 're_private_example_1234',
      },
    });
    const response = await settingsRoutes.request('/', {}, {
      DB: database.db,
    } as Env);

    const body = await response.json<{
      email_sender: { resend_configured: boolean; resend_key_hint: string };
    }>();
    expect(body.email_sender).toMatchObject({
      resend_configured: true,
      resend_key_hint: '••••1234',
    });
    expect(JSON.stringify(body)).not.toContain('re_private_example_1234');
  });

  it('saves a web sender override', async () => {
    const database = fakeDatabase({});
    const response = await settingsRoutes.request('/email-sender', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'resend', from_address: ' notify@example.com ' }),
    }, { DB: database.db } as Env);

    expect(response.status).toBe(200);
    expect(database.statements.some(({ query, values }) => (
      query.includes("INSERT INTO settings") && values[0] === 'email_from_address'
        && values[1] === 'notify@example.com'
    ))).toBe(true);
    expect(database.statements.some(({ query }) => query.includes('INSERT INTO audit_logs')))
      .toBe(true);
  });

  it('clears the web sender override to restore fallback selection', async () => {
    const database = fakeDatabase({});
    const response = await settingsRoutes.request('/email-sender', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'resend', from_address: ' ' }),
    }, { DB: database.db } as Env);

    expect(response.status).toBe(200);
    expect(database.statements.some(({ query, values }) => (
      query.includes('INSERT INTO settings') && values[0] === 'email_from_address'
        && values[1] === ''
    ))).toBe(true);
  });

  it('stores a new Resend API Key without writing it to the audit details', async () => {
    const database = fakeDatabase({});
    const response = await settingsRoutes.request('/email-sender', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'resend',
        from_address: 'notify@example.com',
        resend_api_key: 're_private_example_5678',
      }),
    }, { DB: database.db } as Env);

    expect(response.status).toBe(200);
    expect(database.statements.some(({ query, values }) => (
      query.includes('INSERT INTO settings')
        && values[0] === 'resend_api_key'
        && values[1] === 're_private_example_5678'
    ))).toBe(true);
    const auditStatement = database.statements.find(({ query }) =>
      query.includes('INSERT INTO audit_logs'));
    expect(JSON.stringify(auditStatement)).not.toContain('re_private_example_5678');
  });

  it('preserves a stored Resend API Key when the form leaves it blank', async () => {
    const database = fakeDatabase({});
    const response = await settingsRoutes.request('/email-sender', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'resend',
        from_address: '',
        resend_api_key: '',
      }),
    }, { DB: database.db } as Env);

    expect(response.status).toBe(200);
    expect(database.statements.some(({ query, values }) => (
      query.includes('INSERT INTO settings') && values[0] === 'resend_api_key'
    ))).toBe(false);
  });

  it('clears a stored Resend API Key only when explicitly requested', async () => {
    const database = fakeDatabase({});
    const response = await settingsRoutes.request('/email-sender', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'resend',
        from_address: '',
        clear_resend_api_key: true,
      }),
    }, { DB: database.db } as Env);

    expect(response.status).toBe(200);
    expect(database.statements.some(({ query, values }) => (
      query.includes('INSERT INTO settings')
        && values[0] === 'resend_api_key'
        && values[1] === ''
    ))).toBe(true);
  });

  it('rejects an invalid web sender override', async () => {
    const database = fakeDatabase({});
    const response = await settingsRoutes.request('/email-sender', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'resend', from_address: 'not an email' }),
    }, { DB: database.db } as Env);

    expect(response.status).toBe(400);
    expect(database.statements.some(({ query }) => query.includes('INSERT INTO settings')))
      .toBe(false);
  });

  it('stores a salted password hash and verifies only the correct password', async () => {
    // Cloudflare Workers rejects PBKDF2 iteration counts above 100,000.
    expect(passwordHash).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(passwordHash).not.toContain(PASSWORD);
    await expect(verifyAuthToken(PASSWORD, passwordHash)).resolves.toBe(true);
    await expect(verifyAuthToken('wrong-password', passwordHash)).resolves.toBe(false);
    await expect(verifyAuthToken(PASSWORD, 'malformed')).resolves.toBe(false);
  });

  it('exchanges the password for a random D1-backed session', async () => {
    const database = fakeDatabase({ passwordHash });
    const response = await authRoutes.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    }, { DB: database.db } as Env);

    expect(response.status).toBe(200);
    const body = await response.json<{ token: string; expires_at: string }>();
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.expires_at).toBeTruthy();

    const insert = database.statements.find(({ query }) =>
      query.includes('INSERT INTO admin_sessions'));
    expect(insert).toBeDefined();
    expect(insert?.values[0]).not.toBe(body.token);
    await expect(hashSessionToken(body.token)).resolves.toBe(insert?.values[0]);
  });

  it('requires a password change before creating the first administrator session', async () => {
    const database = fakeDatabase({});
    const response = await authRoutes.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: DEFAULT_INITIAL_PASSWORD }),
    }, { DB: database.db } as Env);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    expect(database.statements.some(({ query }) => query.includes('INSERT INTO admin_sessions')))
      .toBe(false);
  });

  it('stores the replacement password instead of the default password on first login', async () => {
    const database = fakeDatabase({ initializationChanges: 1 });
    const response = await authRoutes.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: DEFAULT_INITIAL_PASSWORD,
        new_password: PASSWORD,
      }),
    }, { DB: database.db } as Env);

    expect(response.status).toBe(201);
    const body = await response.json<{ token: string }>();
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const passwordUpdate = database.statements.find(({ query }) =>
      query.includes('ON CONFLICT(key) DO NOTHING'));
    expect(passwordUpdate).toBeDefined();
    expect(passwordUpdate?.values[0]).not.toBe(PASSWORD);
    await expect(
      verifyAuthToken(DEFAULT_INITIAL_PASSWORD, String(passwordUpdate?.values[0])),
    ).resolves.toBe(false);
    await expect(verifyAuthToken(PASSWORD, String(passwordUpdate?.values[0]))).resolves.toBe(true);
  });

  it('does not overwrite an administrator initialized by a concurrent first request', async () => {
    const database = fakeDatabase({ initializationChanges: 0 });
    const response = await authRoutes.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: DEFAULT_INITIAL_PASSWORD,
        new_password: PASSWORD,
      }),
    }, { DB: database.db } as Env);

    expect(response.status).toBe(409);
    expect(database.statements.some(({ query }) => query.includes('INSERT INTO admin_sessions')))
      .toBe(false);
  });

  it('rejects reusing the default password as the replacement password', async () => {
    const database = fakeDatabase({});
    const response = await authRoutes.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: DEFAULT_INITIAL_PASSWORD,
        new_password: DEFAULT_INITIAL_PASSWORD,
      }),
    }, { DB: database.db } as Env);

    expect(response.status).toBe(400);
    expect(database.statements.some(({ query }) => query.includes('ON CONFLICT(key) DO NOTHING')))
      .toBe(false);
  });

  it('rejects a wrong default password without initializing the administrator', async () => {
    const database = fakeDatabase({});
    const response = await authRoutes.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    }, { DB: database.db } as Env);

    expect(response.status).toBe(401);
    expect(database.statements.some(({ query }) => query.includes('ON CONFLICT(key) DO NOTHING')))
      .toBe(false);
  });

  it('accepts a bearer session but rejects the removed query-token form', async () => {
    const app = protectedApp(sessionHash);

    const authorized = await app.request('/', {
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    });
    expect(authorized.status).toBe(200);

    const queryToken = await app.request(`/?token=${encodeURIComponent(SESSION_TOKEN)}`);
    expect(queryToken.status).toBe(401);
  });

  it('rejects requests when no matching session exists', async () => {
    const response = await protectedApp(null).request('/', {
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    });
    expect(response.status).toBe(401);
  });

  it('rotates the password hash and all sessions atomically', async () => {
    const database = fakeDatabase({ passwordHash });
    const response = await settingsRoutes.request('/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_token: 'another-secure-password' }),
    }, { DB: database.db } as Env);

    expect(response.status).toBe(200);
    const body = await response.json<{ token: string }>();
    const passwordUpdate = database.statements.find(({ query }) =>
      query.includes("VALUES ('auth_token', ?)"));
    const sessionInsert = database.statements.find(({ query }) =>
      query.includes('INSERT INTO admin_sessions'));

    expect(passwordUpdate?.values[0]).not.toBe('another-secure-password');
    await expect(
      verifyAuthToken('another-secure-password', String(passwordUpdate?.values[0])),
    ).resolves.toBe(true);
    expect(database.statements.some(({ query }) => query.includes('DELETE FROM admin_sessions')))
      .toBe(true);
    await expect(hashSessionToken(body.token)).resolves.toBe(sessionInsert?.values[0]);
    expect(database.batch).toHaveBeenCalledTimes(2);
    expect(database.statements.some(({ query }) => query.includes('INSERT INTO audit_logs')))
      .toBe(true);
  });
});

function protectedApp(validSessionHash: string | null) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', authMiddleware);
  app.get('/', (c) => c.json({ success: true }));
  const database = fakeDatabase({ validSessionHash });
  return {
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, { DB: database.db } as Env),
  };
}

function fakeDatabase(options: {
  passwordHash?: string | null;
  validSessionHash?: string | null;
  initializationChanges?: number;
  settings?: Record<string, string>;
}) {
  const statements: Array<{ query: string; values: unknown[] }> = [];
  const batch = vi.fn(async () => []);
  const db = {
    prepare: vi.fn((query: string) => {
      const record = { query, values: [] as unknown[] };
      statements.push(record);
      return {
        bind: (...values: unknown[]) => {
          record.values = values;
          const statement = {
            query,
            values,
            first: async () => {
              if (query.includes('SELECT value FROM settings')) {
                const key = String(values[0] ?? '');
                if (Object.hasOwn(options.settings ?? {}, key)) {
                  return { value: options.settings?.[key] };
                }
                return key === 'auth_token' && options.passwordHash
                  ? { value: options.passwordHash }
                  : null;
              }
              if (query.includes('SELECT token_hash FROM admin_sessions')) {
                return options.validSessionHash === values[0]
                  ? { token_hash: options.validSessionHash }
                  : null;
              }
              return null;
            },
            run: async () => ({
              success: true,
              meta: {
                changes: query.includes('ON CONFLICT(key) DO NOTHING')
                  ? (options.initializationChanges ?? 1)
                  : 1,
              },
            }),
          };
          return statement;
        },
      };
    }),
    batch,
  } as unknown as D1Database;
  return { db, statements, batch };
}
