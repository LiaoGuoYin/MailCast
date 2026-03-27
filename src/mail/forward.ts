import type { ParsedMail } from "./parser";

export interface ForwardResult {
  ok: boolean;
  reason?: string;
}

export async function forwardRawEmail(
  message: ForwardableEmailMessage,
  targets: string[]
): Promise<ForwardResult[]> {
  const results: ForwardResult[] = [];
  for (const target of targets) {
    try {
      await message.forward(target);
      results.push({ ok: true });
    } catch (error) {
      results.push({ ok: false, reason: error instanceof Error ? error.message : "unknown error" });
    }
  }
  return results;
}

export function buildForwardTargets(defaultForwardEmail: string, routeEmails: string[]): string[] {
  const merged = new Set<string>();
  if (defaultForwardEmail) merged.add(defaultForwardEmail);
  for (const email of routeEmails) merged.add(email);
  return [...merged];
}

export function buildMailDigest(mail: ParsedMail): string {
  const snippet = mail.text.slice(0, 300).replace(/\s+/g, " ").trim();
  return [
    `From: ${mail.from}`,
    `To: ${mail.to}`,
    `Subject: ${mail.subject || "(empty subject)"}`,
    `Snippet: ${snippet || "(empty body)"}`
  ].join("\n");
}
