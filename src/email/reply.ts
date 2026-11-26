import PostalMime, { type Address } from 'postal-mime';
import { validateEmailAddress } from './forward';

export interface ReplyMetadata {
  replyAddress: string;
  messageId: string;
  references: string;
}

const MAX_HEADER_SLICE_CHARS = 64 * 1024;

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function firstValidAddress(addresses: Address[] | Address | undefined): string {
  if (!addresses) return '';
  const list = Array.isArray(addresses) ? addresses : [addresses];
  for (const entry of list) {
    if (entry.address) {
      const candidate = entry.address.trim();
      if (validateEmailAddress(candidate) === null) return candidate;
    } else if (Array.isArray(entry.group)) {
      for (const member of entry.group) {
        const candidate = member.address?.trim() ?? '';
        if (validateEmailAddress(candidate) === null) return candidate;
      }
    }
  }
  return '';
}

export function extractHeaderBlock(rawBody: string): string {
  if (!rawBody) return '';
  const crlfBreak = rawBody.indexOf('\r\n\r\n');
  const lfBreak = rawBody.indexOf('\n\n');
  let end = rawBody.length;
  if (crlfBreak !== -1 && (lfBreak === -1 || crlfBreak < lfBreak)) {
    end = crlfBreak;
  } else if (lfBreak !== -1) {
    end = lfBreak;
  }
  const bounded = rawBody.slice(0, Math.min(end, MAX_HEADER_SLICE_CHARS));
  return `${bounded}\r\n\r\n`;
}

// `emails.from_addr` stores the SMTP envelope sender, which for newsletters and
// SaaS notifications is often a VERP bounce address. Parsing the stored raw
// headers on demand recovers the real Reply-To / From and threading headers
// without changing inbound storage.
export async function parseReplyMetadata(
  rawBody: string,
  fallbackFromAddr: string,
): Promise<ReplyMetadata> {
  const fallback = validateEmailAddress(fallbackFromAddr.trim()) === null
    ? fallbackFromAddr.trim()
    : '';
  const headerBlock = extractHeaderBlock(rawBody);
  if (!headerBlock) {
    return { replyAddress: fallback, messageId: '', references: '' };
  }

  try {
    const parsed = await new PostalMime().parse(headerBlock);
    const replyAddress = firstValidAddress(parsed.replyTo)
      || firstValidAddress(parsed.from)
      || fallback;
    const messageId = parsed.messageId ? sanitizeHeaderValue(parsed.messageId) : '';
    const references = parsed.references ? sanitizeHeaderValue(parsed.references) : '';
    return { replyAddress, messageId, references };
  } catch {
    return { replyAddress: fallback, messageId: '', references: '' };
  }
}

export function buildReplyHeaders(
  meta: Pick<ReplyMetadata, 'messageId' | 'references'>,
): Record<string, string> | undefined {
  const messageId = sanitizeHeaderValue(meta.messageId);
  if (!messageId) return undefined;

  const refs = sanitizeHeaderValue(meta.references)
    .split(/\s+/)
    .filter(Boolean);
  if (!refs.includes(messageId)) {
    refs.push(messageId);
  }

  return {
    'In-Reply-To': messageId,
    References: refs.join(' '),
  };
}

export function replySubject(subject: string): string {
  const value = subject.trim() || '（无主题）';
  return /^re:\s*/i.test(value) ? value : `Re: ${value}`;
}
