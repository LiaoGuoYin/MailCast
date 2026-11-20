-- Incoming prefixes are lower-cased before matching, so any rule saved with
-- upper-case letters has never fired. Normalising them makes those rules work.
UPDATE forward_rules SET prefix = lower(prefix) WHERE prefix <> lower(prefix);
UPDATE tg_rules SET prefix = lower(prefix) WHERE prefix <> lower(prefix);
UPDATE bark_rules SET prefix = lower(prefix) WHERE prefix <> lower(prefix);

-- The routing view shows the latest delivery per rule; without this it would
-- scan the whole downstream history on every visit.
CREATE INDEX idx_email_downstreams_rule_latest
  ON email_downstreams(channel, rule_id, last_triggered_at DESC, id DESC)
  WHERE source = 'rule';
