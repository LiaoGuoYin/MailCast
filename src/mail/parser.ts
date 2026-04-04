import PostalMime from "postal-mime";

export interface ParsedMail {
  from: string;
  to: string;
  subject: string;
  date: string;
  messageId: string;
  text: string;
  html: string;
  raw: string;
  receivedAt: string;
}

export async function parseMail(message: ForwardableEmailMessage): Promise<ParsedMail> {
  const raw = await new Response(message.raw).text();
  const parsed = await PostalMime.parse(raw);

  const text = parsed.text || parsed.html?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "";

  return {
    from: message.from,
    to: message.to,
    subject: parsed.subject || "",
    date: parsed.date || "",
    messageId: parsed.messageId || crypto.randomUUID(),
    text,
    html: parsed.html || "",
    raw,
    receivedAt: new Date().toISOString(),
  };
}
