export interface ProcessLog {
  messageId: string;
  routeKey: string;
  tgTargets: string[];
  aiStatus: "skipped" | "ok" | "failed";
  forwardStatus: "ok" | "partial" | "failed";
  errors: string[];
}

export function logProcess(event: ProcessLog): void {
  console.log(JSON.stringify({ type: "mail_process", ...event }));
}

export async function isDuplicate(
  kv: KVNamespace | undefined,
  messageId: string
): Promise<boolean> {
  if (!kv || !messageId) return false;
  const key = `mail:${messageId}`;
  const existing = await kv.get(key);
  if (existing) return true;
  await kv.put(key, "1", { expirationTtl: 60 * 60 * 24 });
  return false;
}
