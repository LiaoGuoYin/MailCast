import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BARK_BODY_BYTE_LIMIT,
  BARK_TITLE_BYTE_LIMIT,
  BarkApiError,
  barkKeyHint,
  buildBarkEmailBody,
  normalizeBarkServerUrl,
  sendBarkPush,
  truncateBarkText,
} from '../src/bark/notify';

afterEach(() => vi.unstubAllGlobals());

describe('Bark notifications', () => {
  it('normalizes official and self-hosted HTTPS server addresses', () => {
    expect(normalizeBarkServerUrl('https://api.day.app/')).toBe('https://api.day.app');
    expect(normalizeBarkServerUrl('https://push.example.com/base/push')).toBe('https://push.example.com/base');
    expect(() => normalizeBarkServerUrl('http://localhost:8080')).toThrow('HTTPS');
    expect(() => normalizeBarkServerUrl('https://127.0.0.1')).toThrow('公开 HTTPS 域名');
  });

  it('posts JSON to the v2 push endpoint without placing the key in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 200, message: 'success' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await sendBarkPush('https://api.day.app', 'secret-device-key', {
      title: 'Test', body: 'Hello',
    });

    expect(fetchMock).toHaveBeenCalledWith('https://api.day.app/push', expect.objectContaining({
      method: 'POST',
    }));
    const init = fetchMock.mock.calls[0][1];
    expect(JSON.parse(init.body)).toMatchObject({
      device_key: 'secret-device-key', title: 'Test', body: 'Hello',
    });
  });

  it('truncates long Bark text by JSON-encoded UTF-8 bytes', async () => {
    const longTitle = '验证码通知'.repeat(100);
    const longBody = '📨这是一封很长的中文邮件正文'.repeat(500);
    const title = truncateBarkText(longTitle, BARK_TITLE_BYTE_LIMIT);
    const body = truncateBarkText(longBody, BARK_BODY_BYTE_LIMIT);

    expect(new TextEncoder().encode(JSON.stringify(title)).byteLength).toBeLessThanOrEqual(BARK_TITLE_BYTE_LIMIT);
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThanOrEqual(BARK_BODY_BYTE_LIMIT);
    expect(title.endsWith('…')).toBe(true);
    expect(body.endsWith('…')).toBe(true);
    expect(title).not.toContain('�');
    expect(body).not.toContain('�');
  });

  it('returns bounded safe metadata and formats email summaries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 400, message: 'invalid device key' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    await expect(sendBarkPush('https://api.day.app', 'bad-key', {
      title: 'Test', body: 'Hello',
    })).rejects.toBeInstanceOf(BarkApiError);
    expect(barkKeyHint('super-secret-key')).toBe('-key');
    expect(buildBarkEmailBody({
      from: 'from@example.com', to: 'to@example.com', body: '<p>Code body</p>', code: '123456',
    })).toContain('验证码：123456');
  });
});
