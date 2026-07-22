import type { AiConfig } from './types';

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function putSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}

export const DEFAULT_AI_CONFIG: AiConfig = { provider: 'none', model: '', base_url: '', api_key: '' };

export async function getAiConfig(db: D1Database): Promise<AiConfig> {
  const raw = await getSetting(db, 'ai_config');
  if (!raw) return { ...DEFAULT_AI_CONFIG };
  try {
    return { ...DEFAULT_AI_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_AI_CONFIG };
  }
}

export function getAuthTokenHash(db: D1Database): Promise<string | null> {
  return getSetting(db, 'auth_token');
}
