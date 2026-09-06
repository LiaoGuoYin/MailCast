import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  document.body.innerHTML = readFileSync('public/index.html', 'utf8').match(/<body>([\s\S]*)<\/body>/)[1]
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('boots without the removed password forms and explains how to recover access', async () => {
  await import('../public/app.js');
  expect(document.querySelector('#login-screen').classList.contains('hidden')).toBe(false);
  expect(document.querySelector('#password-form')).toBeNull();
  expect(document.querySelector('#initial-password-fields')).toBeNull();
  expect(document.querySelector('#login-help').textContent).toContain('ADMIN_PASSWORD');

  fetch.mockResolvedValue(new Response(JSON.stringify({
    error: '请在 Cloudflare 配置 ADMIN_PASSWORD Secret 并部署。',
    code: 'ADMIN_PASSWORD_NOT_CONFIGURED',
  }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
  document.querySelector('#token-input').value = 'example-password';
  document.querySelector('#login-form').dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => {
    expect(document.querySelector('#login-error').hidden).toBe(false);
    expect(document.querySelector('#login-error').textContent).toContain('ADMIN_PASSWORD');
  });
  expect(document.querySelector('#login-btn').disabled).toBe(false);
  expect(localStorage.getItem('mailcast_token')).toBeNull();
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ password: 'example-password' });
});
