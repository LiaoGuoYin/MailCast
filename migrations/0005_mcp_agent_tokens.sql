CREATE TABLE agent_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'static' CHECK (kind IN ('static', 'oauth')),
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  prefixes TEXT NOT NULL DEFAULT '[]',
  allow_plus_tags INTEGER NOT NULL DEFAULT 1,
  recipient_policy TEXT NOT NULL DEFAULT 'allowlist'
    CHECK (recipient_policy IN ('allowlist', 'any')),
  recipient_allowlist TEXT NOT NULL DEFAULT '[]',
  send_limit_hour INTEGER NOT NULL DEFAULT 10,
  send_limit_day INTEGER NOT NULL DEFAULT 30,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  last_used_ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_agent_tokens_revoked_expires
  ON agent_tokens(revoked_at, expires_at);

ALTER TABLE sent_emails ADD COLUMN agent_token_id INTEGER;
ALTER TABLE sent_emails ADD COLUMN idempotency_key TEXT;
ALTER TABLE sent_emails ADD COLUMN idempotency_hash TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX idx_sent_emails_idem
  ON sent_emails(agent_token_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status = 'success';

CREATE INDEX idx_sent_emails_token_created
  ON sent_emails(agent_token_id, created_at DESC, id DESC);

CREATE INDEX idx_emails_to_prefix_id
  ON emails(to_prefix, id DESC);

CREATE TABLE audit_logs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK (
    category IN ('delivery', 'auth', 'bot', 'rule', 'settings', 'email')
  ),
  action TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'info')),
  actor TEXT NOT NULL CHECK (actor IN ('admin', 'system', 'agent')),
  actor_id TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  ip_address TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

INSERT INTO audit_logs_new
  (id, category, action, status, actor, actor_id, target_type, target_id,
   summary, details, ip_address, created_at)
SELECT
  id, category, action, status, actor, '', target_type, target_id,
  summary, details, ip_address, created_at
FROM audit_logs;

DROP TABLE audit_logs;
ALTER TABLE audit_logs_new RENAME TO audit_logs;

CREATE INDEX idx_audit_logs_created_at
  ON audit_logs(created_at DESC, id DESC);
CREATE INDEX idx_audit_logs_category_created_at
  ON audit_logs(category, created_at DESC, id DESC);
CREATE INDEX idx_audit_logs_actor_created_at
  ON audit_logs(actor, actor_id, created_at DESC, id DESC);
