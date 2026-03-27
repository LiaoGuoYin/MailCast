import type { ParsedMail } from "../mail/parser";
import type { ExtractedSignal } from "../ai/extract";

function safe(value: string): string {
  return value.replace(/\n/g, " ").trim();
}

export function formatTelegramMessage(mail: ParsedMail, signal?: ExtractedSignal): string {
  const firstLine = signal?.code
    ? `OTP: ${signal.code} (${Math.round((signal.confidence ?? 0) * 100)}%)`
    : "Mail arrived";
  const secondLine = `${safe(mail.from)} -> ${safe(mail.to)}`;
  const thirdLine = `Subject: ${safe(mail.subject || "(empty subject)")}`;
  const fourthLine = signal?.service ? `Service: ${signal.service}` : "";
  const snippet = safe(mail.text.slice(0, 350));
  return [firstLine, secondLine, thirdLine, fourthLine, `Snippet: ${snippet}`]
    .filter(Boolean)
    .join("\n");
}
