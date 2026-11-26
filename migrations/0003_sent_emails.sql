CREATE TABLE sent_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_prefix TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  reply_to TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  reply_to_email_id INTEGER REFERENCES emails(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  provider_message_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sent_emails_created_at ON sent_emails(created_at DESC, id DESC);
CREATE INDEX idx_sent_emails_reply_to
  ON sent_emails(reply_to_email_id, created_at DESC, id DESC)
  WHERE reply_to_email_id IS NOT NULL;
