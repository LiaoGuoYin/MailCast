CREATE TABLE emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  to_prefix TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  html_body TEXT NOT NULL DEFAULT '',
  body_truncated INTEGER NOT NULL DEFAULT 0,
  raw_body TEXT NOT NULL DEFAULT '',
  raw_truncated INTEGER NOT NULL DEFAULT 0,
  downstream_recorded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE email_destinations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  email_address TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE forward_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prefix TEXT NOT NULL,
  destination_id INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (destination_id) REFERENCES email_destinations(id) ON DELETE RESTRICT
);

CREATE TABLE telegram_bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  token TEXT NOT NULL,
  token_hint TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  telegram_user_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tg_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prefix TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  bot_id INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (bot_id) REFERENCES telegram_bots(id) ON DELETE RESTRICT
);

CREATE TABLE bark_endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  server_url TEXT NOT NULL,
  device_key TEXT NOT NULL,
  key_hint TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE bark_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prefix TEXT NOT NULL,
  endpoint_id INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (endpoint_id) REFERENCES bark_endpoints(id) ON DELETE RESTRICT
);

CREATE TABLE email_downstreams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('forward', 'telegram', 'bark')),
  source TEXT NOT NULL CHECK (source IN ('rule', 'quick_forward')),
  rule_id INTEGER,
  target TEXT NOT NULL,
  telegram_bot_id INTEGER,
  telegram_bot_name TEXT NOT NULL DEFAULT '',
  bark_endpoint_id INTEGER,
  bark_endpoint_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 1,
  last_error TEXT NOT NULL DEFAULT '',
  last_triggered_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK (
    category IN ('delivery', 'auth', 'bot', 'rule', 'settings', 'email')
  ),
  action TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'info')),
  actor TEXT NOT NULL CHECK (actor IN ('admin', 'system')),
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  ip_address TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_emails_to_prefix ON emails(to_prefix);
CREATE INDEX idx_emails_created_at ON emails(created_at DESC);
CREATE INDEX idx_forward_rules_prefix ON forward_rules(prefix);
CREATE INDEX idx_forward_rules_destination_id ON forward_rules(destination_id);
CREATE INDEX idx_tg_rules_prefix ON tg_rules(prefix);
CREATE INDEX idx_tg_rules_bot_id ON tg_rules(bot_id);
CREATE INDEX idx_bark_rules_prefix ON bark_rules(prefix);
CREATE INDEX idx_bark_rules_endpoint_id ON bark_rules(endpoint_id);
CREATE INDEX idx_email_downstreams_email_id
  ON email_downstreams(email_id, created_at, id);
CREATE INDEX idx_admin_sessions_expires_at ON admin_sessions(expires_at);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC, id DESC);
CREATE INDEX idx_audit_logs_category_created_at
  ON audit_logs(category, created_at DESC, id DESC);
