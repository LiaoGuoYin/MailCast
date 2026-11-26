import { describe, expect, it, vi } from 'vitest';
import {
  CloudflareOutboundEmailProvider,
  OutboundEmailError,
  ResendOutboundEmailProvider,
  buildComposedAddresses,
  normalizeSenderPrefix,
  resolveOutboundEmailProvider,
  sendComposedEmail,
  validateSenderPrefix,
} from '../src/email/outbound';

const message = {
  from: 'forwarder@example.com',
  to: 'target@example.net',
  replyTo: 'sender@example.org',
  subject: 'Fwd: Test',
  text: 'Plain body',
  html: '<p>HTML body</p>',
};

describe('outbound email providers', () => {
  it('calls the default Resend fetcher without the provider as its receiver', async () => {
    const platformFetch = vi.fn(function (this: unknown) {
      expect(this).toBeUndefined();
      return Promise.resolve(new Response(
        JSON.stringify({ id: 'resend-message-id' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    });
    vi.stubGlobal('fetch', platformFetch);

    try {
      const provider = new ResendOutboundEmailProvider('re_test_key');

      await expect(provider.send(message)).resolves.toEqual({
        messageId: 'resend-message-id',
      });
      expect(platformFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps a forwarded message to the Resend API', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: 'resend-message-id' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const provider = new ResendOutboundEmailProvider('re_test_key', fetcher);

    await expect(provider.send(message)).resolves.toEqual({
      messageId: 'resend-message-id',
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer re_test_key',
      'Content-Type': 'application/json',
      'User-Agent': 'MailCast/0.1.0',
    });
    expect(JSON.parse(init.body)).toEqual({
      from: 'MailCast <forwarder@example.com>',
      to: 'target@example.net',
      reply_to: 'sender@example.org',
      subject: 'Fwd: Test',
      text: 'Plain body',
      html: '<p>HTML body</p>',
    });
  });

  it('normalizes Resend API errors without exposing the API Key', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ name: 'validation_error', message: 'Invalid from field' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    ));
    const provider = new ResendOutboundEmailProvider('re_secret_value', fetcher);

    await expect(provider.send(message)).rejects.toMatchObject({
      provider: 'resend',
      code: 'RESEND_VALIDATION_ERROR',
      httpStatus: 422,
      description: 'Invalid from field',
    });
    await provider.send(message).catch((error: OutboundEmailError) => {
      expect(JSON.stringify(error)).not.toContain('re_secret_value');
    });
  });

  it('maps Cloudflare binding results and errors', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ messageId: 'cloudflare-message-id' })
      .mockRejectedValueOnce(Object.assign(new Error('Domain unavailable'), {
        code: 'E_SENDER_DOMAIN_NOT_AVAILABLE',
      }));
    const provider = new CloudflareOutboundEmailProvider({ send });

    await expect(provider.send(message)).resolves.toEqual({
      messageId: 'cloudflare-message-id',
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      from: { email: 'forwarder@example.com', name: 'MailCast' },
      to: 'target@example.net',
      replyTo: 'sender@example.org',
    }));
    await expect(provider.send(message)).rejects.toMatchObject({
      provider: 'cloudflare',
      code: 'E_SENDER_DOMAIN_NOT_AVAILABLE',
      description: 'Domain unavailable',
    });
  });

  it('defaults to Resend and reports a missing API Key', async () => {
    await expect(resolveOutboundEmailProvider({
      DB: settingsDatabase({}),
    })).rejects.toMatchObject({
      provider: 'resend',
      code: 'RESEND_NOT_CONFIGURED',
      httpStatus: null,
    });
  });

  it('reports a missing Cloudflare binding when that provider is selected', async () => {
    await expect(resolveOutboundEmailProvider({
      DB: settingsDatabase({ email_provider: 'cloudflare' }),
    })).rejects.toMatchObject({
      provider: 'cloudflare',
      code: 'CLOUDFLARE_EMAIL_NOT_CONFIGURED',
      httpStatus: null,
    });
  });

  it('sends composed plain-text email with prefix display name and reply headers via Resend', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: 'resend-composed-id' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const provider = new ResendOutboundEmailProvider('re_test_key', fetcher);

    const result = await sendComposedEmail(provider, {
      prefix: 'github',
      sendDomain: 'mail.example.com',
      receiveDomain: 'example.com',
      to: 'alice@example.net',
      subject: 'Re: Issue #42',
      text: 'Thanks!',
      headers: {
        'In-Reply-To': '<orig@example.net>',
        References: '<orig@example.net>',
      },
    });

    expect(result).toEqual({
      messageId: 'resend-composed-id',
      from: 'github@mail.example.com',
      replyTo: 'github@example.com',
    });
    const [, init] = fetcher.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      from: 'github <github@mail.example.com>',
      to: 'alice@example.net',
      reply_to: 'github@example.com',
      subject: 'Re: Issue #42',
      text: 'Thanks!',
      headers: {
        'In-Reply-To': '<orig@example.net>',
        References: '<orig@example.net>',
      },
    });
  });

  it('passes custom fromName and headers to Cloudflare Email Sending and omits html when absent', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'cf-composed-id' });
    const provider = new CloudflareOutboundEmailProvider({ send });

    const result = await sendComposedEmail(provider, {
      prefix: 'hi',
      sendDomain: 'example.com',
      receiveDomain: 'example.com',
      to: 'bob@example.net',
      subject: 'Hello',
      text: 'Plain message',
      headers: { 'In-Reply-To': '<msg@example.net>' },
    });

    expect(result).toEqual({
      messageId: 'cf-composed-id',
      from: 'hi@example.com',
      replyTo: '',
    });
    expect(send).toHaveBeenCalledWith({
      from: { email: 'hi@example.com', name: 'hi' },
      to: 'bob@example.net',
      subject: 'Hello',
      text: 'Plain message',
      headers: { 'In-Reply-To': '<msg@example.net>' },
    });
  });

  it('validates sender prefixes and builds composed addresses', () => {
    expect(normalizeSenderPrefix('  GitHub+Tag  ')).toBe('github+tag');
    expect(validateSenderPrefix('github')).toBeNull();
    expect(validateSenderPrefix('a')).toBeNull();
    expect(validateSenderPrefix('my.alias_1+tag-2')).toBeNull();
    expect(validateSenderPrefix('')).toBeTruthy();
    expect(validateSenderPrefix('*')).toContain('*');
    expect(validateSenderPrefix('.leading')).toBeTruthy();
    expect(validateSenderPrefix('trailing.')).toBeTruthy();
    expect(validateSenderPrefix('a..b')).toBeTruthy();
    expect(validateSenderPrefix('bad space')).toBeTruthy();

    expect(buildComposedAddresses('hi', 'example.com', 'example.com')).toEqual({
      from: 'hi@example.com',
    });
    expect(buildComposedAddresses('hi', 'mail.example.com', 'example.com')).toEqual({
      from: 'hi@mail.example.com',
      replyTo: 'hi@example.com',
    });
  });
});

function settingsDatabase(settings: Record<string, string>) {
  return {
    prepare: vi.fn(() => ({
      bind: (key: string) => ({
        first: vi.fn().mockResolvedValue(
          Object.hasOwn(settings, key) ? { value: settings[key] } : null,
        ),
      }),
    })),
  };
}
