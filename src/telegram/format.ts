import type { ParsedMail } from "../mail/parser";
import type { ExtractedSignal } from "../ai/extract";

function safe(value: string): string {
  return value.replace(/\n/g, " ").trim();
}

// High confidence signal → short message, codeOrLink front and center
function formatShortMessage(mail: ParsedMail, signal: ExtractedSignal): string {
  return [
    `🔑 ${signal.codeOrLink}`,
    signal.service ? `Service: ${signal.service}` : "",
    `${safe(mail.from)} -> ${safe(mail.to)}`,
    `Subject: ${safe(mail.subject || "(empty subject)")}`
  ]
    .filter(Boolean)
    .join("\n");
}

// Default full format
function formatFullMessage(mail: ParsedMail): string {
  const snippet = safe(mail.text.slice(0, 1000));
  return [
    "Mail arrived",
    `${safe(mail.from)} -> ${safe(mail.to)}`,
    `Subject: ${safe(mail.subject || "(empty subject)")}`,
    `Snippet: ${snippet}`
  ].join("\n");
}

const CONFIDENCE_THRESHOLD = 0.75;

export function formatTelegramMessage(mail: ParsedMail, signal?: ExtractedSignal): string {
  if (signal?.codeOrLink && (signal.confidence ?? 0) >= CONFIDENCE_THRESHOLD) {
    return formatShortMessage(mail, signal);
  }
  return formatFullMessage(mail);
}
