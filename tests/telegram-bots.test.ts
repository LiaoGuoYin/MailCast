import { afterEach, describe, expect, it, vi } from 'vitest';
import { settingsRoutes } from '../src/api/settings';
import { resolveTelegramDeliveryBot } from '../src/telegram/bots';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Telegram Bot registry', () => {
  it('lists safe metadata without selecting or returning tokens', async () => {
    const all = vi.fn().mockResolvedValue({
      results: [{
        id: 1,
        name: '验证码通知',
        token_hint: 'cdef',
        username: 'code_bot',
        telegram_user_id: '123',
        rule_count: 2,
        created_at: '2026-07-22T00:00:00.000Z',
        updated_at: '2026-07-22T00:00:00.000Z',
      }],
    });
    const prepare = vi.fn((query: string) => ({ all, query }));

    const response = await settingsRoutes.request('/telegram-bots', {}, {
      DB: { prepare },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty('legacy_bot_available');
    expect(body.data[0]).toMatchObject({ name: '验证码通知', token_hint: 'cdef', rule_count: 2 });
    expect(prepare.mock.calls[0][0]).not.toMatch(/b\.token(?:\s|,)/);
  });

  it('validates and stores a new token but never echoes the full token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: { id: 123, first_name: 'Inbox', username: 'inbox_bot' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const run = vi.fn().mockResolvedValue({ meta: { last_row_id: 7 } });
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const batch = vi.fn().mockResolvedValue([]);

    const response = await settingsRoutes.request('/telegram-bots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '主通知', token: '123456:very-secret-token' }),
    }, { DB: { prepare, batch } });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ id: 7, name: '主通知', token_hint: 'oken', username: 'inbox_bot' });
    expect(JSON.stringify(body)).not.toContain('very-secret-token');
    expect(bind.mock.calls[0]).toContain('123456:very-secret-token');
    expect(prepare.mock.calls.some(([query]) => String(query).includes('INSERT INTO audit_logs')))
      .toBe(true);
    expect(JSON.stringify(bind.mock.calls.slice(1))).not.toContain('very-secret-token');
  });

  it('blocks deletion while a push rule still references the Bot', async () => {
    const first = vi.fn()
      .mockResolvedValueOnce({
        id: 2,
        name: '主通知',
        token: 'secret',
        token_hint: 'cret',
        username: 'bot',
        telegram_user_id: '123',
        created_at: '',
        updated_at: '',
      })
      .mockResolvedValueOnce({ count: 3 });
    const prepare = vi.fn(() => ({ bind: () => ({ first }) }));

    const response = await settingsRoutes.request('/telegram-bots/2', {
      method: 'DELETE',
    }, { DB: { prepare } });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: '仍有 3 条推送规则使用此 Bot，请先修改或删除这些规则',
    });
  });

  it('resolves a stored Bot for delivery and rejects rules without a Bot', async () => {
    const first = vi.fn().mockResolvedValue({
      id: 9,
      name: '营销通知',
      token: 'stored-token',
      token_hint: 'oken',
      username: 'marketing_bot',
      telegram_user_id: '999',
      created_at: '',
      updated_at: '',
    });
    const bind = vi.fn(() => ({ first }));
    const env = { DB: { prepare: vi.fn(() => ({ bind })) } };

    // Assert the lookup key, not an echo of the mock: that is what proves the
    // resolver fetched the bot the rule is bound to.
    await expect(resolveTelegramDeliveryBot(env as never, 9)).resolves.toEqual({ token: 'stored-token' });
    expect(bind).toHaveBeenCalledWith(9);
    await expect(resolveTelegramDeliveryBot(env as never, null))
      .rejects.toThrow('Telegram 推送未绑定 Bot，请重新配置规则');
  });
});
