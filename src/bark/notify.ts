export const BARK_TITLE_BYTE_LIMIT = 200;
export const BARK_BODY_BYTE_LIMIT = 3000;

const textEncoder = new TextEncoder();

function removeDanglingHighSurrogate(value: string): string {
  const lastCodeUnit = value.charCodeAt(value.length - 1);
  return lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF ? value.slice(0, -1) : value;
}

/**
 * Keep notification text within a JSON-encoded UTF-8 byte budget. APNs limits
 * the complete payload to 4 KiB, so title and body deliberately leave room for
 * Bark's aps wrapper, group and other metadata.
 */
export function truncateBarkText(value: string, maxBytes: number): string {
  const text = value.trim();
  if (!text || textEncoder.encode(JSON.stringify(text)).byteLength <= maxBytes) return text;

  const suffix = '…';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = removeDanglingHighSurrogate(text.slice(0, middle));
    const size = textEncoder.encode(JSON.stringify(`${candidate.trimEnd()}${suffix}`)).byteLength;
    if (size <= maxBytes) low = middle;
    else high = middle - 1;
  }

  const truncated = removeDanglingHighSurrogate(text.slice(0, low));
  return `${truncated.trimEnd()}${suffix}`;
}

interface BarkResponse {
  code?: number;
  message?: string;
}

export class BarkApiError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly errorCode: number | null,
    public readonly description: string,
  ) {
    super(description);
    this.name = 'BarkApiError';
  }
}

export function normalizeBarkServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('请输入有效的 Bark Server 地址');
  }
  if (url.protocol !== 'https:') throw new Error('Bark Server 必须使用 HTTPS');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Bark Server 地址不能包含账号、查询参数或片段');
  }
  if (!url.hostname || url.hostname === 'localhost') {
    throw new Error('Bark Server 地址不可使用本机地址');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
    || hostname.includes(':')
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
  ) {
    throw new Error('Bark Server 请使用公开 HTTPS 域名，不支持本机或 IP 地址');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/push$/, '');
  return url.toString().replace(/\/$/, '');
}

export function barkKeyHint(key: string): string {
  return key.slice(-4);
}

export async function sendBarkPush(
  serverUrl: string,
  deviceKey: string,
  input: { title: string; body: string; group?: string },
): Promise<void> {
  const title = truncateBarkText(input.title, BARK_TITLE_BYTE_LIMIT) || 'MailCast';
  const body = truncateBarkText(input.body, BARK_BODY_BYTE_LIMIT) || '（无正文）';
  const response = await fetch(`${normalizeBarkServerUrl(serverUrl)}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      device_key: deviceKey,
      title,
      body,
      group: input.group || 'mailcast',
    }),
  });

  const payload: BarkResponse = await response.json<BarkResponse>().catch(() => ({}));
  if (!response.ok || (payload.code !== undefined && payload.code !== 200)) {
    throw new BarkApiError(
      response.status,
      typeof payload.code === 'number' ? payload.code : null,
      payload.message || `Bark 返回 HTTP ${response.status}`,
    );
  }
}

export function buildBarkEmailBody(input: {
  from: string;
  to: string;
  body: string;
  code?: string | null;
}): string {
  const preview = input.body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return [
    input.code ? `验证码：${input.code}` : '',
    `发件人：${input.from}`,
    `收件人：${input.to}`,
    '',
    preview || '（无正文）',
  ].filter((line, index) => line || index > 1).join('\n');
}
