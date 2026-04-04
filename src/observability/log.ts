export interface ProcessLog {
  messageId: string;
  routeKey: string;
  tgTargets: string[];
  aiStatus: "skipped" | "ok" | "failed";
  forwardStatus: "ok" | "partial" | "failed";
  errors: string[];
}

export interface MailRecord {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  rawEmail: string;
  routeKey: string;
  forwardStatus: string;
  aiStatus: string;
}

export function logProcess(event: ProcessLog): void {
  console.log(JSON.stringify({ type: "mail_process", ...event }));
}

export async function isDuplicate(
  db: D1Database,
  messageId: string
): Promise<boolean> {
  if (!messageId) return false;
  const row = await db.prepare(
    "SELECT 1 FROM mail_cache WHERE message_id = ?"
  ).bind(messageId).first();
  return row !== null;
}

export async function saveMailRecord(
  db: D1Database,
  record: MailRecord
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO mail_cache
       (message_id, from_addr, to_addr, subject, body_text, raw_email, route_key, forward_status, ai_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).bind(
    record.messageId,
    record.from,
    record.to,
    record.subject,
    record.bodyText,
    record.rawEmail,
    record.routeKey,
    record.forwardStatus,
    record.aiStatus
  ).run();
}
