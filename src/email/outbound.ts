import { getEmailDeliveryConfig } from '../settings';
import { errorDescription, errorProperty } from './errors';
import type { EmailProvider, Env } from '../types';
import { buildForwardedEmail, validateEmailAddress } from './forward';
import type { DeliveryEmail } from './downstream';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const USER_AGENT = 'MailCast/0.1.0';

export interface OutboundEmailMessage {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
}

export interface OutboundEmailResult {
  messageId: string;
}

export interface OutboundEmailProvider {
  readonly name: EmailProvider;
  send(message: OutboundEmailMessage): Promise<OutboundEmailResult>;
}

export class OutboundEmailError extends Error {
  readonly provider: EmailProvider;
  readonly code: string;
  readonly httpStatus: number | null;
  readonly description: string;

  constructor(
    provider: EmailProvider,
    code: string,
    description: string,
    httpStatus: number | null = null,
  ) {
    super(description);
    this.name = 'OutboundEmailError';
    this.provider = provider;
    this.code = code;
    this.httpStatus = httpStatus;
    this.description = description;
  }
}

export class ResendOutboundEmailProvider implements OutboundEmailProvider {
  readonly name = 'resend' as const;

  constructor(
    private readonly apiKey: string,
    // Wrap the runtime function so `this.fetcher()` cannot bind Cloudflare's `fetch` to this provider.
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async send(message: OutboundEmailMessage): Promise<OutboundEmailResult> {
    let response: Response;
    try {
      response = await this.fetcher(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify({
          from: `MailCast <${message.from}>`,
          to: message.to,
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
      });
    } catch (error) {
      throw new OutboundEmailError(
        'resend',
        'RESEND_REQUEST_FAILED',
        errorDescription(error, 'Unknown outbound email error'),
      );
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // A malformed provider response is handled below without exposing its body.
    }

    if (!response.ok) {
      const providerName = errorProperty(payload, 'name');
      const providerMessage = errorProperty(payload, 'message');
      throw new OutboundEmailError(
        'resend',
        typeof providerName === 'string'
          ? `RESEND_${providerName.toUpperCase()}`
          : `RESEND_HTTP_${response.status}`,
        typeof providerMessage === 'string'
          ? providerMessage
          : `Resend request failed with HTTP ${response.status}`,
        response.status,
      );
    }

    const id = errorProperty(payload, 'id');
    if (typeof id !== 'string' || !id) {
      throw new OutboundEmailError(
        'resend',
        'RESEND_INVALID_RESPONSE',
        'Resend did not return a message ID',
        response.status,
      );
    }
    return { messageId: id };
  }
}

export class CloudflareOutboundEmailProvider implements OutboundEmailProvider {
  readonly name = 'cloudflare' as const;

  constructor(private readonly binding: SendEmail) {}

  async send(message: OutboundEmailMessage): Promise<OutboundEmailResult> {
    try {
      const result = await this.binding.send({
        from: { email: message.from, name: 'MailCast' },
        to: message.to,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      return { messageId: result.messageId };
    } catch (error) {
      const code = errorProperty(error, 'code');
      throw new OutboundEmailError(
        'cloudflare',
        typeof code === 'string' ? code : 'CLOUDFLARE_EMAIL_ERROR',
        errorDescription(error, 'Unknown outbound email error'),
      );
    }
  }
}

export async function resolveOutboundEmailProvider(
  env: Env,
): Promise<OutboundEmailProvider> {
  const config = await getEmailDeliveryConfig(env.DB);
  if (config.provider === 'resend') {
    if (!config.resend_api_key) {
      throw new OutboundEmailError(
        'resend',
        'RESEND_NOT_CONFIGURED',
        'Resend 尚未配置，请在设置中填写 API Key',
      );
    }
    return new ResendOutboundEmailProvider(config.resend_api_key);
  }

  if (!env.EMAIL) {
    throw new OutboundEmailError(
      'cloudflare',
      'CLOUDFLARE_EMAIL_NOT_CONFIGURED',
      'Cloudflare Email Sending 尚未配置，请先为 Worker 添加 EMAIL binding',
    );
  }
  return new CloudflareOutboundEmailProvider(env.EMAIL);
}

export async function sendForwardedEmail(
  provider: OutboundEmailProvider,
  fromAddress: string,
  email: DeliveryEmail,
  target: string,
): Promise<string> {
  const problem = validateEmailAddress(target);
  if (problem) throw new Error(problem);

  const forwarded = buildForwardedEmail(email);
  const replyTo = validateEmailAddress(email.from_addr) === null
    ? email.from_addr
    : undefined;
  const result = await provider.send({
    from: fromAddress,
    to: target,
    ...(replyTo ? { replyTo } : {}),
    subject: forwarded.subject,
    text: forwarded.text,
    html: forwarded.html,
  });
  return result.messageId;
}
