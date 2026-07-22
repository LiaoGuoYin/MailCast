import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware, authRoutes } from '../src/api/auth';
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

  it('exposes the receiving domain without exposing the sender address', async () => {
    const database = fakeDatabase({});
    const response = await settingsRoutes.request('/', {}, {
      DB: database.db,
      EMAIL_FROM_ADDRESS: 'forwarder@mail.example.com',
    } as unknown as Env);

    expect(response.status).toBe(200);
    const body = await response.json<{ mail_domain: string }>();
    expect(body.mail_domain).toBe('mail.example.com');
    expect(JSON.stringify(body)).not.toContain('forwarder@');
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
                return options.passwordHash ? { value: options.passwordHash } : null;
              }
              if (query.includes('SELECT token_hash FROM admin_sessions')) {
                return options.validSessionHash === values[0]
                  ? { token_hash: options.validSessionHash }
                  : null;
              }
              return null;
            },
            run: async () => ({ success: true }),
          };
          return statement;
        },
      };
    }),
    batch,
  } as unknown as D1Database;
  return { db, statements, batch };
}
