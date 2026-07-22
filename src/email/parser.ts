import PostalMime, { type RawEmail } from 'postal-mime';

export const TEXT_BODY_LIMIT_BYTES = 512 * 1024;
export const HTML_BODY_LIMIT_BYTES = 1024 * 1024;
export const RAW_BODY_LIMIT_BYTES = 256 * 1024;

export interface ParsedEmail {
  from_addr: string;
  to_addr: string;
  to_prefix: string;
  subject: string;
  text_body: string;
  html_body: string;
  body_truncated: number;
  raw_body: string;
  raw_truncated: number;
}

interface TruncatedBody {
  value: string;
  truncated: boolean;
}

export function truncateUtf8(value: string, maxBytes: number): TruncatedBody {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= maxBytes) {
    return { value, truncated: false };
  }

  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let end = maxBytes;
  while (end > Math.max(0, maxBytes - 4)) {
    try {
      return {
        value: decoder.decode(encoded.subarray(0, end)),
        truncated: true,
      };
    } catch {
      end -= 1;
    }
  }

  return { value: '', truncated: true };
}

export async function parseRawEmail(
  rawEmail: RawEmail,
  envelopeFrom: string,
  envelopeTo: string,
): Promise<ParsedEmail> {
  const rawBytes = await readRawBytes(rawEmail);
  const parsed = await new PostalMime().parse(rawBytes);

  const text = truncateUtf8(parsed.text || '', TEXT_BODY_LIMIT_BYTES);
  const html = truncateUtf8(parsed.html || '', HTML_BODY_LIMIT_BYTES);
  const decodedRaw = new TextDecoder('utf-8').decode(
    rawBytes.subarray(0, RAW_BODY_LIMIT_BYTES),
  );
  const raw = truncateUtf8(decodedRaw, RAW_BODY_LIMIT_BYTES);
  const to_prefix = envelopeTo.split('@')[0].toLowerCase();

  return {
    from_addr: envelopeFrom,
    to_addr: envelopeTo,
    to_prefix,
    subject: parsed.subject || '',
    text_body: text.value,
    html_body: html.value,
    body_truncated: text.truncated || html.truncated ? 1 : 0,
    raw_body: raw.value,
    raw_truncated: rawBytes.byteLength > RAW_BODY_LIMIT_BYTES || raw.truncated ? 1 : 0,
  };
}

async function readRawBytes(rawEmail: RawEmail): Promise<Uint8Array> {
  if (typeof rawEmail === 'string') {
    return new TextEncoder().encode(rawEmail);
  }

  if (rawEmail instanceof ArrayBuffer) {
    return new Uint8Array(rawEmail);
  }

  if (ArrayBuffer.isView(rawEmail)) {
    return new Uint8Array(
      rawEmail.buffer,
      rawEmail.byteOffset,
      rawEmail.byteLength,
    ).slice();
  }

  if (rawEmail instanceof Blob) {
    return new Uint8Array(await rawEmail.arrayBuffer());
  }

  return new Uint8Array(await new Response(rawEmail).arrayBuffer());
}

export function parseEmail(message: ForwardableEmailMessage): Promise<ParsedEmail> {
  return parseRawEmail(message.raw, message.from, message.to);
}
