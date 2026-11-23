import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatTgNotification,
  getTelegramBotIdentity,
  sendTgNotification,
  sendTgTextMessage,
  TelegramApiError,
} from '../src/telegram/notify';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Telegram notifications', () => {
  it('validates a Bot Token and returns only safe Bot identity fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        ok: true,
        result: { id: 123456789, is_bot: true, first_name: 'Inbox', username: 'inbox_bot' },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getTelegramBotIdentity('123:secret-value')).resolves.toEqual({
      id: '123456789',
      username: 'inbox_bot',
    });
    expect(fetchMock).toHaveBeenCalledWith('https://api.telegram.org/bot123:secret-value/getMe');
  });

  it('fails before making a request when the bot token is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendTgTextMessage('', '123', 'test'))
      .rejects.toThrow('Telegram Bot Token is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a test message to the requested chat', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true, result: { message_id: 1 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await sendTgTextMessage('bot-token', '-100123', '调试消息');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botbot-token/sendMessage');
    expect(JSON.parse(String(init?.body))).toEqual({
      chat_id: '-100123',
      text: '调试消息',
    });
  });

  it('reports Telegram API failures instead of silently succeeding', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        ok: false,
        error_code: 400,
        description: 'Bad Request: chat not found',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(sendTgTextMessage('bot-token', 'missing', 'test')).rejects.toMatchObject({
      name: 'TelegramApiError',
      errorCode: 400,
      httpStatus: 400,
      description: 'Bad Request: chat not found',
    } satisfies Partial<TelegramApiError>);
  });

  it('keeps formatted email notifications concise and within Telegram text limits', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await sendTgNotification('bot-token', '123', {
      from: 'from@example.com',
      to: 'to@example.com',
      subject: 'Long message',
      body: 'a'.repeat(5000),
      code: '482913',
    });

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(requestBody.text.length).toBeLessThan(800);
    expect(requestBody.text).toContain('验证码: 482913');
    expect(requestBody.text.endsWith('…')).toBe(true);
  });

  it('strips leaked CSS and prefers AI summary when available', () => {
    const cleanedFallback = formatTgNotification({
      from: 'notification@bnesim.com',
      to: 'i@liaoguoyin.com',
      subject: 'Thanks, your eSIM is ready',
      body: '*{box-sizing: border-box;} @media (max-width:620px){.a{display:none;}}\n\nYour eSIM is ready to install.',
    });

    expect(cleanedFallback).not.toContain('box-sizing');
    expect(cleanedFallback).not.toContain('@media');
    expect(cleanedFallback).toContain('Your eSIM is ready to install.');

    const withSummary = formatTgNotification({
      from: 'notification@bnesim.com',
      to: 'i@liaoguoyin.com',
      subject: 'Thanks, your eSIM is ready',
      body: 'Long body text',
      summary: 'BNESIM 通知您的 eSIM 已准备就绪，可前往 App 扫码安装。',
    });

    expect(withSummary).toContain('📝 摘要: BNESIM 通知您的 eSIM 已准备就绪，可前往 App 扫码安装。');
    expect(withSummary).not.toContain('Long body text');
  });

  it('still enforces Telegram hard 4096-character ceiling on raw text messages', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await sendTgTextMessage('bot-token', '123', 'a'.repeat(5000));

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(requestBody.text.length).toBe(4096);
    expect(requestBody.text.endsWith('…')).toBe(true);
  });
});
