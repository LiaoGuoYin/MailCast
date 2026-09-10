import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BODY = readFileSync('public/index.html', 'utf8')
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');

function json(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

// Answers every GET with an empty catalog so booting the module is quiet, and
// hands POSTs to the per-test responder.
function stubFetch(onPost) {
  const fetchMock = vi.fn((url, options = {}) => (
    options.method === 'POST' ? onPost(String(url), JSON.parse(options.body)) : json({ data: [] })
  ));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const posts = (fetchMock) => fetchMock.mock.calls.filter(([, o]) => o && o.method === 'POST');

function toastTexts() {
  return [...document.querySelectorAll('#toast-root .toast')].map((el) => el.textContent);
}

function fill(form, values) {
  for (const [name, value] of Object.entries(values)) form.elements[name].value = value;
}

function submit(form) {
  form.dispatchEvent(new Event('submit', { cancelable: true }));
}

function watchClose(overlay) {
  const state = { closed: false };
  overlay.addEventListener('modal-closed', () => { state.closed = true; });
  return state;
}

describe('destination create modals', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = BODY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('email destination', () => {
    it('refuses to submit an incomplete form and does not call the API', async () => {
      const fetchMock = stubFetch(() => json({}));
      const app = await import('../public/app.js');
      app.openEmailDestinationCreateModal({});

      submit(document.querySelector('.create-email-destination-form'));
      await Promise.resolve();

      expect(posts(fetchMock)).toHaveLength(0);
      expect(toastTexts().join()).toContain('请填写目标名称和邮箱地址');
    });

    it('posts the trimmed payload, closes, and hands the created row to onCreated', async () => {
      const created = { id: 3, name: '个人邮箱', email_address: 'me@example.com' };
      const fetchMock = stubFetch(() => json(created));
      const app = await import('../public/app.js');
      const onCreated = vi.fn();
      app.openEmailDestinationCreateModal({ onCreated });
      const overlay = document.querySelector('.modal-overlay');
      const closing = watchClose(overlay);
      const form = document.querySelector('.create-email-destination-form');
      fill(form, { name: '  个人邮箱  ', email_address: '  me@example.com  ' });

      submit(form);
      await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));

      const [url, options] = posts(fetchMock)[0];
      expect(url).toBe('/api/destinations/emails');
      expect(JSON.parse(options.body)).toEqual({ name: '个人邮箱', email_address: 'me@example.com' });
      expect(closing.closed).toBe(true);
      expect(toastTexts().join()).toContain('邮件目标已添加');
    });

    it('reports a failed create and restores the submit button', async () => {
      stubFetch(() => json({ error: '名称或邮箱地址已存在' }, 409));
      const app = await import('../public/app.js');
      app.openEmailDestinationCreateModal({});
      const form = document.querySelector('.create-email-destination-form');
      fill(form, { name: '个人邮箱', email_address: 'me@example.com' });
      const button = form.querySelector('button[type="submit"]');

      submit(form);
      await vi.waitFor(() => expect(toastTexts().join()).toContain('添加失败'));

      expect(toastTexts().join()).toContain('名称或邮箱地址已存在');
      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe('添加并选中');
    });
  });

  describe('bark destination', () => {
    it('refuses to submit an incomplete form', async () => {
      const fetchMock = stubFetch(() => json({}));
      const app = await import('../public/app.js');
      app.openBarkDestinationCreateModal({});
      const form = document.querySelector('.create-bark-destination-form');
      fill(form, { name: '我的 iPhone', device_key: '' });

      submit(form);
      await Promise.resolve();

      expect(posts(fetchMock)).toHaveLength(0);
      expect(toastTexts().join()).toContain('请填写名称、Device Key 和 Server 地址');
    });

    it('posts all three fields and keeps the default server url', async () => {
      const created = { id: 8, name: '我的 iPhone' };
      const fetchMock = stubFetch(() => json(created));
      const app = await import('../public/app.js');
      const onCreated = vi.fn();
      app.openBarkDestinationCreateModal({ onCreated });
      const form = document.querySelector('.create-bark-destination-form');
      fill(form, { name: '我的 iPhone', device_key: 'devicekey' });

      submit(form);
      await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));

      const [url, options] = posts(fetchMock)[0];
      expect(url).toBe('/api/destinations/bark');
      expect(JSON.parse(options.body)).toEqual({
        name: '我的 iPhone',
        device_key: 'devicekey',
        server_url: 'https://api.day.app',
      });
      expect(toastTexts().join()).toContain('Bark 目标已添加');
    });
  });

  describe('telegram bot', () => {
    it('refuses to submit an incomplete form', async () => {
      const fetchMock = stubFetch(() => json({}));
      const app = await import('../public/app.js');
      app.openTelegramBotCreateModal({});

      submit(document.querySelector('.create-telegram-bot-form'));
      await Promise.resolve();

      expect(posts(fetchMock)).toHaveLength(0);
      expect(toastTexts().join()).toContain('请填写 Bot 名称和 Token');
    });

    it('posts the bot and restores its own submit label', async () => {
      const created = { id: 9, name: '验证码通知', username: 'code_bot' };
      const fetchMock = stubFetch(() => json(created));
      const app = await import('../public/app.js');
      const onCreated = vi.fn();
      app.openTelegramBotCreateModal({ onCreated });
      const form = document.querySelector('.create-telegram-bot-form');
      fill(form, { name: '验证码通知', token: '123:secret' });

      submit(form);
      await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));

      const [url, options] = posts(fetchMock)[0];
      expect(url).toBe('/api/settings/telegram-bots');
      expect(JSON.parse(options.body)).toEqual({ name: '验证码通知', token: '123:secret' });
      expect(toastTexts().join()).toContain('Bot 已验证并添加');
    });

    // Telegram is the one channel that reports a nested reason, and the modal is
    // the only place a user sees it.
    it('surfaces the Telegram rejection detail, not just the generic message', async () => {
      stubFetch(() => json({
        error: 'Telegram Bot Token 验证失败',
        telegram: { code: 401, description: 'Unauthorized' },
      }, 502));
      const app = await import('../public/app.js');
      app.openTelegramBotCreateModal({});
      const form = document.querySelector('.create-telegram-bot-form');
      fill(form, { name: '验证码通知', token: 'bad' });
      const button = form.querySelector('button[type="submit"]');

      submit(form);
      await vi.waitFor(() => expect(toastTexts().join()).toContain('添加失败'));

      expect(toastTexts().join()).toContain('Unauthorized');
      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe('验证、添加并选中');
    });

    it('warns when the list refresh after a successful create fails', async () => {
      stubFetch(() => json({ id: 9 }));
      const app = await import('../public/app.js');
      const onCreated = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
      app.openTelegramBotCreateModal({ onCreated });
      const form = document.querySelector('.create-telegram-bot-form');
      fill(form, { name: '验证码通知', token: '123:secret' });

      submit(form);
      await vi.waitFor(() => expect(toastTexts().join()).toContain('Bot 列表刷新失败'));

      expect(toastTexts().join()).toContain('Bot 已验证并添加');
    });
  });
});
