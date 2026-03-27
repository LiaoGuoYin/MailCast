export interface ParsedMail {
  from: string;
  to: string;
  subject: string;
  date: string;
  messageId: string;
  text: string;
  html: string;
  receivedAt: string;
}

function headerValue(headers: Headers, key: string): string {
  return headers.get(key) ?? "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickSimpleBody(raw: string): { text: string; html: string } {
  const textMatch = raw.match(/content-type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--|$)/i);
  const htmlMatch = raw.match(/content-type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--|$)/i);
  const text = (textMatch?.[1] ?? "").trim();
  const html = (htmlMatch?.[1] ?? "").trim();
  return { text, html };
}

export async function parseMail(message: ForwardableEmailMessage): Promise<ParsedMail> {
  const raw = await new Response(message.raw).text();
  const parsedBody = pickSimpleBody(raw);
  const headers = message.headers;

  const subject = headerValue(headers, "subject");
  const date = headerValue(headers, "date");
  const messageId = headerValue(headers, "message-id") || crypto.randomUUID();

  const text = parsedBody.text || stripHtml(parsedBody.html) || raw.slice(0, 2000);
  return {
    from: message.from,
    to: message.to,
    subject,
    date,
    messageId,
    text,
    html: parsedBody.html,
    receivedAt: new Date().toISOString()
  };
}
