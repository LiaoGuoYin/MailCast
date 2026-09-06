import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware, authRoutes } from '../src/api/auth';
import { hashSessionToken } from '../src/auth/session';
import { verifyAdminPassword } from '../src/auth/token';
import { mailDomainFromAddress, settingsRoutes } from '../src/api/settings';
import type { Env } from '../src/types';

const PASSWORD = 'correct-horse-42';
const SESSION_TOKEN = 'a'.repeat(43);
let sessionHash = '';

beforeAll(async () => {
  sessionHash = await hashSessionToken(SESSION_TOKEN, PASSWORD);
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

  it('compares only the exact configured password', async () => {
    await expect(verifyAdminPassword(PASSWORD, PASSWORD)).resolves.toBe(true);
    await expect(verifyAdminPassword('wrong-password', PASSWORD)).resolves.toBe(false);
    await expect(verifyAdminPassword(`${PASSWORD}x`, PASSWORD)).resolves.toBe(false);
  });

  it('exchanges the Secret for a random session without storing the password', async () => {
    const database = fakeDatabase({ settings: { auth_token: 'obsolete-d1-password' } });
    const response = await login(database.db, PASSWORD);
    expect(response.status).toBe(200);
    const body = await response.json<{ token: string; expires_at: string }>();
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.expires_at).toBeTruthy();
    const insert = database.statements.find(({ query }) => query.includes('INSERT INTO admin_sessions'));
    await expect(hashSessionToken(body.token, PASSWORD)).resolves.toBe(insert?.values[0]);
    expect(insert?.values[0]).not.toBe(body.token);
    expect(JSON.stringify(database.statements)).not.toContain(PASSWORD);
    expect(database.statements.some(({ query }) => query.includes('FROM settings'))).toBe(false);
  });

  it.each([undefined, '', 'short', 'has whitespace', 'x'.repeat(257)])(
    'fails closed when the configured Secret is invalid: %s', async (configuredPassword) => {
      const database = fakeDatabase({ settings: { auth_token: PASSWORD } });
      const response = await login(database.db, PASSWORD, configuredPassword);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'ADMIN_PASSWORD_NOT_CONFIGURED' });
      expect(database.statements).toEqual([]);
      expect((await protectedApp(sessionHash, configuredPassword).request('/', {
        headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
      })).status).toBe(401);
    },
  );

  it.each(['mailcast123', 'obsolete-d1-password', 'wrong-password', ` ${PASSWORD}`, `${PASSWORD} `,
    null, 123, {}, 'x'.repeat(257)])('rejects invalid login input without a fallback: %s', async (password) => {
    const database = fakeDatabase({ settings: { auth_token: 'obsolete-d1-password' } });
    const response = await login(database.db, password);
    expect(response.status).toBe(401);
    expect(database.statements.some(({ query }) => query.includes('INSERT INTO admin_sessions'))).toBe(false);
    expect(JSON.stringify(database.statements)).not.toContain('obsolete-d1-password');
  });

  it('rejects malformed JSON without creating a session', async () => {
    const database = fakeDatabase({});
    const response = await authRoutes.request('/login', {
      method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' },
    }, { DB: database.db, ADMIN_PASSWORD: PASSWORD } as Env);
    expect(response.status).toBe(401);
    expect(database.statements.some(({ query }) => query.includes('INSERT INTO admin_sessions'))).toBe(false);
  });

  it('rejects legacy sessions created before Secret-based authentication', async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SESSION_TOKEN));
    const legacyHash = Buffer.from(digest).toString('base64url');
    expect((await protectedApp(legacyHash).request('/', {
      headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    })).status).toBe(401);
  });

  it('invalidates old sessions and passwords when a different Secret is deployed', async () => {
    const database = fakeDatabase({});
    const oldLogin = await login(database.db, PASSWORD);
    const oldSession = await oldLogin.json<{ token: string }>();
    const oldHash = database.statements.find(({ query }) => query.includes('INSERT INTO admin_sessions'))?.values[0];
    const nextPassword = 'next-admin-password';
    expect((await protectedApp(String(oldHash)).request('/', {
      headers: { Authorization: `Bearer ${oldSession.token}` },
    })).status).toBe(200);
    expect((await protectedApp(String(oldHash), nextPassword).request('/', {
      headers: { Authorization: `Bearer ${oldSession.token}` },
    })).status).toBe(401);
    expect((await login(database.db, PASSWORD, nextPassword)).status).toBe(401);
    const nextDatabase = fakeDatabase({});
    const nextLogin = await login(nextDatabase.db, nextPassword, nextPassword);
    expect(nextLogin.status).toBe(200);
    const nextSession = await nextLogin.json<{ token: string }>();
    const nextHash = nextDatabase.statements.find(({ query }) => query.includes('INSERT INTO admin_sessions'))?.values[0];
    expect((await protectedApp(String(nextHash), nextPassword).request('/', {
      headers: { Authorization: `Bearer ${nextSession.token}` },
    })).status).toBe(200);
  });

  it('revokes the current Secret-bound session on logout', async () => {
    const database = fakeDatabase({ validSessionHash: sessionHash });
    const response = await authRoutes.request('/logout', {
      method: 'POST', headers: { Authorization: `Bearer ${SESSION_TOKEN}` },
    }, { DB: database.db, ADMIN_PASSWORD: PASSWORD } as Env);
    expect(response.status).toBe(200);
    const deletion = database.statements.find(({ query }) => query.includes('DELETE FROM admin_sessions WHERE token_hash'));
    expect(deletion?.values).toEqual([sessionHash]);
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

  it('does not expose a web password update endpoint', async () => {
    const database = fakeDatabase({});
    const response = await settingsRoutes.request('/password', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_token: 'another-secure-password' }),
    }, { DB: database.db, ADMIN_PASSWORD: PASSWORD } as Env);
    expect(response.status).toBe(404);
    expect(database.statements).toEqual([]);
  });
});

function protectedApp(validSessionHash: string | null, ...configuration: [string | undefined] | []) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', authMiddleware);
  app.get('/', (c) => c.json({ success: true }));
  const database = fakeDatabase({ validSessionHash });
  return {
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, { DB: database.db, ADMIN_PASSWORD: configuration.length ? configuration[0] : PASSWORD } as Env),
  };
}

function fakeDatabase(options: {
  validSessionHash?: string | null;
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
                return null;
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
                changes: 1,
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

function login(db: D1Database, password: unknown, ...configuration: [string | undefined] | []) {
  return authRoutes.request('/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  }, { DB: db, ADMIN_PASSWORD: configuration.length ? configuration[0] : PASSWORD } as Env);
}
