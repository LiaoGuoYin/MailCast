import type { AiConfig, EmailProvider } from './types';

const EMAIL_FROM_ADDRESS_KEY = 'email_from_address';
const EMAIL_PROVIDER_KEY = 'email_provider';
const RESEND_API_KEY_KEY = 'resend_api_key';
const UPSERT_SETTING_SQL =
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';

async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function putSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(UPSERT_SETTING_SQL)
    .bind(key, value)
    .run();
}

export interface EmailSenderConfig {
  configured_address: string;
  environment_address: string;
  source: 'web' | 'environment' | 'automatic';
}

export interface EmailDeliveryConfig {
  provider: EmailProvider;
  resend_api_key: string;
}

export interface PublicEmailDeliveryConfig {
  provider: EmailProvider;
  resend_configured: boolean;
  resend_key_hint: string;
}

function normalizeEmailProvider(value: string | null): EmailProvider {
  return value === 'cloudflare' ? 'cloudflare' : 'resend';
}

export function resendKeyHint(apiKey: string): string {
  const normalized = apiKey.trim();
  return normalized ? `••••${normalized.slice(-4)}` : '';
}

export async function getEmailDeliveryConfig(db: D1Database): Promise<EmailDeliveryConfig> {
  const [provider, resendApiKey] = await Promise.all([
    getSetting(db, EMAIL_PROVIDER_KEY),
    getSetting(db, RESEND_API_KEY_KEY),
  ]);
  return {
    provider: normalizeEmailProvider(provider),
    resend_api_key: resendApiKey?.trim() ?? '',
  };
}

export async function getPublicEmailDeliveryConfig(
  db: D1Database,
): Promise<PublicEmailDeliveryConfig> {
  const config = await getEmailDeliveryConfig(db);
  return {
    provider: config.provider,
    resend_configured: Boolean(config.resend_api_key),
    resend_key_hint: resendKeyHint(config.resend_api_key),
  };
}

export async function setEmailSenderSettings(
  db: D1Database,
  input: {
    provider: EmailProvider;
    fromAddress: string;
    resendApiKey?: string;
    clearResendApiKey?: boolean;
  },
): Promise<void> {
  const updates: Array<[string, string]> = [
    [EMAIL_FROM_ADDRESS_KEY, input.fromAddress.trim()],
    [EMAIL_PROVIDER_KEY, input.provider],
  ];
  if (input.clearResendApiKey) {
    updates.push([RESEND_API_KEY_KEY, '']);
  } else if (input.resendApiKey?.trim()) {
    updates.push([RESEND_API_KEY_KEY, input.resendApiKey.trim()]);
  }
  await db.batch(updates.map(([key, value]) =>
    db.prepare(UPSERT_SETTING_SQL).bind(key, value)));
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

// `source` is the one place the configured-beats-environment precedence is
// decided; everything that needs the winning address reads it through here.
export function selectedSenderAddress(config: EmailSenderConfig): string {
  if (config.source === 'web') return config.configured_address;
  if (config.source === 'environment') return config.environment_address;
  return '';
}

export async function getEmailSenderAddress(
  db: D1Database,
  environmentAddress: string | undefined,
  receivingAddress: string,
): Promise<string> {
  const config = await getEmailSenderConfig(db, environmentAddress);
  const selected = selectedSenderAddress(config);
  if (selected) return selected;

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
