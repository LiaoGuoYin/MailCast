ALTER TABLE emails ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0;

-- Existing messages predate read tracking, so avoid presenting the whole
-- historical inbox as newly unread after this migration.
UPDATE emails SET is_read = 1;

CREATE INDEX idx_emails_is_read_created_at
  ON emails(is_read, created_at DESC);
