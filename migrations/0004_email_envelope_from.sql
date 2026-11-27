-- emails.from_addr now stores the RFC 5322 header From (what mail clients show).
-- The SMTP envelope sender (MAIL FROM, often a VERP bounce address) is kept here.
-- Existing rows only have the envelope sender, so copy it over; scripts/backfill-header-from.mjs
-- then re-parses their raw headers to fill from_addr with the header From.
ALTER TABLE emails ADD COLUMN envelope_from TEXT NOT NULL DEFAULT '';
UPDATE emails SET envelope_from = from_addr;
