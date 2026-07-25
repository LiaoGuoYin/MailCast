import type { AiConfig } from './types';

const EMAIL_FROM_ADDRESS_KEY = 'email_from_address';

async function getSetting(db: D1Database, key: string): Promise<string | null> {
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

export interface EmailSenderConfig {
  configured_address: string;
  environment_address: string;
  source: 'web' | 'environment' | 'automatic';
}

export async function getEmailSenderConfig(
  db: D1Database,
  environmentAddress?: string,
): Promise<EmailSenderConfig> {
  const configuredAddress = (await getSetting(db, EMAIL_FROM_ADDRESS_KEY))?.trim() ?? '';
  const normalizedEnvironmentAddress = environmentAddress?.trim() ?? '';
  return {
    configured_address: configuredAddress,
    environment_address: normalizedEnvironmentAddress,
    source: configuredAddress
      ? 'web'
      : normalizedEnvironmentAddress ? 'environment' : 'automatic',
  };
}

export async function setEmailSenderAddress(
  db: D1Database,
  address: string,
): Promise<void> {
  await putSetting(db, EMAIL_FROM_ADDRESS_KEY, address.trim());
}

export async function getEmailSenderAddress(
  db: D1Database,
  environmentAddress: string | undefined,
  receivingAddress: string,
): Promise<string> {
  const config = await getEmailSenderConfig(db, environmentAddress);
  if (config.configured_address) return config.configured_address;
  if (config.environment_address) return config.environment_address;

  const separator = receivingAddress.lastIndexOf('@');
  const domain = separator > 0 ? receivingAddress.slice(separator + 1).trim().toLowerCase() : '';
  if (!domain) {
    throw new Error('无法从收件地址确定发件域名，请在设置中配置发件地址');
  }
  return `forwarder@${domain}`;
}

const DEFAULT_AI_CONFIG: AiConfig = { provider: 'none', model: '', base_url: '', api_key: '' };

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
