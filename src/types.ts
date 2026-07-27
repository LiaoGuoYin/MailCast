export interface Env extends WorkerBindings {
  /** Optional until a domain is onboarded to Cloudflare Email Sending. */
  EMAIL?: SendEmail;
  /** Optional sender override; the web setting wins and the receiving domain is the fallback. */
  EMAIL_FROM_ADDRESS?: string;
}

export type AiProvider = 'none' | 'workers-ai' | 'openai';
export type EmailProvider = 'resend' | 'cloudflare';

export interface AiConfig {
  provider: AiProvider;
  model: string;
  base_url: string;
  api_key: string;
}

export interface EmailRecord {
  id: number;
  from_addr: string;
  to_addr: string;
  to_prefix: string;
  subject: string;
  text_body: string;
  html_body: string;
  body_truncated: number;
  raw_body: string;
  raw_truncated: number;
  downstream_recorded: number;
  is_read: number;
  created_at: string;
}

export type DownstreamChannel = 'forward' | 'telegram' | 'bark';
export type DownstreamSource = 'rule' | 'quick_forward';
export type DownstreamStatus = 'pending' | 'success' | 'failed';

export interface EmailDownstream {
  id: number;
  email_id: number;
  channel: DownstreamChannel;
  source: DownstreamSource;
  rule_id: number | null;
  target: string;
  telegram_bot_id: number | null;
  telegram_bot_name: string;
  bark_endpoint_id: number | null;
  bark_endpoint_name: string;
  status: DownstreamStatus;
  attempt_count: number;
  last_error: string;
  last_triggered_at: string;
  created_at: string;
  updated_at: string;
}

export interface ForwardRule {
  id: number;
  prefix: string;
  destination_id: number;
  destination_name: string;
  target_email: string;
  enabled: number;
  created_at: string;
}

export interface EmailDestination {
  id: number;
  name: string;
  email_address: string;
  rule_count: number;
  created_at: string;
  updated_at: string;
}

export interface TgRule {
  id: number;
  prefix: string;
  chat_id: string;
  bot_id: number | null;
  bot_name?: string;
  bot_username?: string;
  enabled: number;
  created_at: string;
}

export interface TelegramBot {
  id: number;
  name: string;
  token: string;
  token_hint: string;
  username: string;
  telegram_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface TelegramBotSummary extends Omit<TelegramBot, 'token'> {
  rule_count: number;
}

export interface BarkEndpoint {
  id: number;
  name: string;
  server_url: string;
  device_key: string;
  key_hint: string;
  created_at: string;
  updated_at: string;
}

export interface BarkEndpointSummary extends Omit<BarkEndpoint, 'device_key'> {
  rule_count: number;
}

export interface BarkRule {
  id: number;
  prefix: string;
  endpoint_id: number;
  endpoint_name?: string;
  server_url?: string;
  enabled: number;
  created_at: string;
}

export type AuditCategory = 'delivery' | 'auth' | 'bot' | 'rule' | 'settings' | 'email';
export type AuditStatus = 'success' | 'failed' | 'info';
export type AuditActor = 'admin' | 'system';

export interface AuditLog {
  id: number;
  category: AuditCategory;
  action: string;
  status: AuditStatus;
  actor: AuditActor;
  target_type: string;
  target_id: string;
  summary: string;
  details: Record<string, unknown>;
  ip_address: string;
  created_at: string;
}
