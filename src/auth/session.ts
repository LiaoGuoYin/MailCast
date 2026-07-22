const SESSION_BYTES = 32;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const encoder = new TextEncoder();

export interface AdminSession {
  token: string;
  expires_at: string;
}

export async function createAdminSession(db: D1Database): Promise<AdminSession> {
  const session = await newSession();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').bind(now),
    db.prepare(
      'INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)',
    ).bind(session.tokenHash, now, session.expiresAt),
  ]);
  return { token: session.token, expires_at: session.expiresAt };
}

export async function rotateAdminCredentials(
  db: D1Database,
  passwordHash: string,
): Promise<AdminSession> {
  const session = await newSession();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('auth_token', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).bind(passwordHash),
    db.prepare('DELETE FROM admin_sessions'),
    db.prepare(
      'INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)',
    ).bind(session.tokenHash, now, session.expiresAt),
  ]);
  return { token: session.token, expires_at: session.expiresAt };
}

export async function verifyAdminSession(db: D1Database, token: string): Promise<boolean> {
  if (!SESSION_TOKEN_RE.test(token)) return false;
  const tokenHash = await hashSessionToken(token);
  const row = await db.prepare(
    'SELECT token_hash FROM admin_sessions WHERE token_hash = ? AND expires_at > ?',
  ).bind(tokenHash, new Date().toISOString()).first<{ token_hash: string }>();
  return row !== null;
}

export async function deleteAdminSession(db: D1Database, token: string): Promise<void> {
  if (!SESSION_TOKEN_RE.test(token)) return;
  await db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?')
    .bind(await hashSessionToken(token))
    .run();
}

export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return encodeBase64Url(new Uint8Array(digest));
}

async function newSession(): Promise<{
  token: string;
  tokenHash: string;
  expiresAt: string;
}> {
  const token = encodeBase64Url(crypto.getRandomValues(new Uint8Array(SESSION_BYTES)));
  return {
    token,
    tokenHash: await hashSessionToken(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
