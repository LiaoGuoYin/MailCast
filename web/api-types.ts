// JSON shapes of the /api responses the console reads.
//
// These mirror src/types.ts and the route handlers in src/api/ by hand: the
// Worker is compiled against Workers types and the console against DOM types,
// so the two projects cannot share one source file. When a handler changes
// what it returns, update the matching shape here.

export type EmailProvider = 'resend' | 'cloudflare';
export type AiProvider = 'none' | 'workers-ai' | 'openai';

// GET /emails rows: no bodies, only a cleaned preview.
export interface EmailSummary {
  id: number;
  from_addr: string;
  to_addr: string;
  to_prefix: string;
  subject: string;
  is_read: boolean;
  created_at: string;
  body_preview: string;
  snippet: string;
}

export interface EmailListResponse {
  data: EmailSummary[];
  total: number;
  unread_count: number;
  page: number;
  limit: number;
}

export interface UnreadCountResponse {
  unread_count: number;
}

export interface SentEmailRecord {
  id: number;
  from_prefix: string;
  from_addr: string;
  to_addr: string;
  reply_to: string;
  subject: string;
  text_body: string;
  reply_to_email_id: number | null;
  provider: EmailProvider;
  provider_message_id: string;
  status: 'success' | 'failed';
  error: string;
  created_at: string;
  agent_token_id?: number | null;
  idempotency_key?: string | null;
}

// GET /outbound/sent
export interface SentListItem extends SentEmailRecord {
  agent_token_id: number | null;
  agent_token_name: string | null;
}

export interface SentListResponse {
  data: SentListItem[];
  has_more: boolean;
  next_before_id: number | null;
}

// GET /emails/:id
export interface EmailDetail {
  id: number;
  from_addr: string;
  envelope_from: string;
  to_addr: string;
  to_prefix: string;
  subject: string;
  text_body: string;
  html_body: string;
  body_truncated: boolean;
  raw_body: string;
  raw_truncated: boolean;
  downstream_recorded: boolean;
  is_read: boolean;
  created_at: string;
  reply_to_addr: string;
  replies: SentEmailRecord[];
}

export type DownstreamChannel = 'forward' | 'telegram' | 'bark';
export type DownstreamStatus = 'pending' | 'success' | 'failed';

export interface EmailDownstream {
  id: number;
  email_id: number;
  channel: DownstreamChannel;
  source: 'rule' | 'quick_forward';
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
  is_stale: boolean;
}

// GET /emails/:id/downstreams
export interface DownstreamListResponse {
  tracked: boolean;
  data: EmailDownstream[];
}

// GET /outbound/context
export interface OutboundContext {
  configured: boolean;
  provider: EmailProvider;
  send_domain: string;
  receive_domain: string;
  prefixes: string[];
}

// POST /outbound/send
export interface SendEmailResponse {
  success: boolean;
  id: number;
  message_id: string;
  from: string;
  reply_to: string;
  sent: SentEmailRecord | null;
}

// Rule rows. `enabled` is SQLite's 0/1, not a boolean.
export interface ForwardRule {
  id: number;
  prefix: string;
  destination_id: number;
  destination_name: string;
  target_email: string;
  enabled: number;
  created_at: string;
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

export interface BarkRule {
  id: number;
  prefix: string;
  endpoint_id: number;
  endpoint_name?: string;
  server_url?: string;
  enabled: number;
  created_at: string;
}

// The console's own key for a rule's channel; the API's downstream records
// say 'telegram' where the rule routes say 'tg'.
export type ChannelKey = 'forward' | 'tg' | 'bark';

// The rules view merges the three rule lists into one, tagging each row with
// the list it came from. The tag is what narrows a row to its channel's shape.
export type ChannelRule =
  | (ForwardRule & { channel: 'forward' })
  | (TgRule & { channel: 'tg' })
  | (BarkRule & { channel: 'bark' });

export interface RuleDeliveryActivity {
  channel: ChannelKey;
  rule_id: number;
  status: DownstreamStatus;
  last_error: string;
  last_triggered_at: string;
}

export interface PrefixActivity {
  prefix: string;
  last_received_at: string;
  email_count: number;
}

// GET /rules/activity
export interface RuleActivity {
  deliveries: RuleDeliveryActivity[];
  prefixes: PrefixActivity[];
}

// POST /rules/:channel, POST /destinations/*, POST /settings/telegram-bots
export interface CreatedResponse {
  id: number;
}

export interface EmailDestination {
  id: number;
  name: string;
  email_address: string;
  rule_count: number;
  created_at: string;
  updated_at: string;
}

export interface BarkEndpoint {
  id: number;
  name: string;
  server_url: string;
  key_hint: string;
  rule_count: number;
  created_at: string;
  updated_at: string;
}

export interface TelegramBot {
  id: number;
  name: string;
  token_hint: string;
  username: string;
  telegram_user_id: string;
  rule_count: number;
  created_at: string;
  updated_at: string;
}

// GET /destinations/emails, GET /destinations/bark, GET /settings/telegram-bots
export interface DataResponse<T> {
  data: T[];
}

export interface AiConfig {
  provider: AiProvider;
  model: string;
  base_url: string;
  api_key: string;
}

export interface EmailSenderSettings {
  configured_address: string;
  environment_address: string;
  source: 'web' | 'environment' | 'automatic';
  provider: EmailProvider;
  resend_configured: boolean;
  resend_key_hint: string;
  binding_configured: boolean;
}

// GET /settings
export interface SettingsResponse {
  ai: AiConfig;
  email_sender: EmailSenderSettings;
  mail_domain: string;
}

// POST /settings/email-sender/test
export interface SenderTestResponse {
  from_address: string;
}

// GET /setup
export interface SetupStatus {
  receiving: { done: boolean; domain: string };
  rules: { done: boolean; count: number };
  sending: { done: boolean; required: boolean; provider: EmailProvider };
  complete: boolean;
}

export interface AuditLog {
  id: number;
  category: 'delivery' | 'auth' | 'bot' | 'rule' | 'settings' | 'email';
  action: string;
  status: 'success' | 'failed' | 'info';
  actor: 'admin' | 'system' | 'agent';
  actor_id: string;
  target_type: string;
  target_id: string;
  summary: string;
  details: Record<string, unknown>;
  ip_address: string;
  created_at: string;
}

export type AgentScope = 'mail:read' | 'mail:send';
export type AgentRecipientPolicy = 'allowlist' | 'any';

export interface AgentTokenSummary {
  id: number;
  name: string;
  kind: 'static' | 'oauth';
  token_hint: string;
  scopes: AgentScope[];
  prefixes: string[];
  allow_plus_tags: boolean;
  recipient_policy: AgentRecipientPolicy;
  recipient_allowlist: string[];
  send_limit_hour: number;
  send_limit_day: number;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  last_used_ip: string;
  created_at: string;
  updated_at: string;
  status: 'active' | 'revoked' | 'expired';
}

export interface McpSettings {
  enabled: boolean;
  daily_send_limit: number;
}

// GET /settings/mcp
export interface McpAdminResponse {
  settings: McpSettings;
  tokens: AgentTokenSummary[];
  known_prefixes: string[];
  domains: {
    send_domain: string;
    receive_domain: string;
  };
  endpoint_path: string;
  usage: {
    instance_day_used: number;
  };
}

// POST /settings/mcp/tokens
export interface CreatedAgentTokenResponse {
  token: string;
  item: AgentTokenSummary;
}

// GET /logs
export interface LogListResponse {
  data: AuditLog[];
  total: number;
  page: number;
  limit: number;
}

// GET /api/meta
export interface BuildMetadata {
  app_version: string | null;
  commit: string | null;
  deployed_at: string | null;
  deployment_id: string | null;
}

// POST /api/auth/login
export interface LoginResponse {
  token: string;
  expires_at: string;
}

// What a failed request's JSON body may carry next to `error`. Which extra
// field is present depends on the endpoint that failed.
export interface ProviderErrorDetails {
  error_code?: number;
  http_status?: number;
  code?: string;
  description?: string;
}

export interface ApiErrorBody {
  error?: unknown;
  code?: string;
  telegram?: ProviderErrorDetails;
  bark?: ProviderErrorDetails;
  downstream?: ProviderErrorDetails;
  email?: ProviderErrorDetails;
  sent?: SentEmailRecord | null;
}
