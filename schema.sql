-- Mail cache: stores processed emails for dedup and preview
CREATE TABLE IF NOT EXISTS mail_cache (
  message_id     TEXT PRIMARY KEY,
  from_addr      TEXT NOT NULL,
  to_addr        TEXT NOT NULL,
  subject        TEXT NOT NULL DEFAULT '',
  body_text      TEXT NOT NULL DEFAULT '',
  route_key      TEXT NOT NULL DEFAULT '',
  forward_status TEXT NOT NULL DEFAULT '',
  ai_status      TEXT NOT NULL DEFAULT '',
  raw_email      TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Route rules: prefix-based routing config
-- Use prefix = '*' for the default route
CREATE TABLE IF NOT EXISTS route_rules (
  prefix         TEXT PRIMARY KEY,
  telegram_chats TEXT NOT NULL DEFAULT '[]',
  emails         TEXT NOT NULL DEFAULT '[]',
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
