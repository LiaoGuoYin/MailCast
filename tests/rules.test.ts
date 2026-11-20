import { describe, expect, it, vi } from 'vitest';
import {
  ruleRoutes,
  telegramTestErrorPayload,
  validateForwardRuleInput,
  validateTgRuleInput,
} from '../src/api/rules';
import { TelegramApiError } from '../src/telegram/notify';

describe('Telegram rule validation', () => {
  it('accepts exact prefixes, wildcard rules, and private or group chat IDs', () => {
    expect(validateTgRuleInput('inbox', '1234567890', 1)).toBeNull();
    expect(validateTgRuleInput('*', '-1001234567890', 2)).toBeNull();
  });

  it('rejects invalid prefixes and chat IDs used by create and edit', () => {
    expect(validateTgRuleInput('bad prefix', '123', 1)).toContain('前缀');
    expect(validateTgRuleInput('inbox', '@channel', 1)).toContain('Chat ID');
    expect(validateTgRuleInput('inbox', '123', null)).toContain('Bot');
  });

  it('returns safe Telegram details without exposing the Bot Token', () => {
    const payload = telegramTestErrorPayload(new TelegramApiError(
      400,
      'Bad Request: chat not found',
      400,
    ));

    expect(payload).toEqual({
      error: 'Telegram 测试消息发送失败',
      telegram: {
        error_code: 400,
        http_status: 400,
        description: 'Bad Request: chat not found',
      },
    });
    expect(JSON.stringify(payload)).not.toContain('bot');
  });
});

describe('Forward rule validation', () => {
  it('accepts exact prefixes, wildcard rules, and saved destinations', () => {
    expect(validateForwardRuleInput('inbox', 1)).toBeNull();
    expect(validateForwardRuleInput('*', 2)).toBeNull();
  });

  it('returns the expected Chinese validation messages', () => {
    expect(validateForwardRuleInput('', 1)).toBe('请填写收件前缀');
    expect(validateForwardRuleInput('bad prefix', 1))
      .toBe('前缀只能是 *，或包含字母、数字、点、下划线和连字符');
    expect(validateForwardRuleInput('inbox', null)).toBe('请选择邮件目标');
  });
});

describe('Forward rule updates', () => {
  it('updates a matching rule with trimmed values', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const bind = vi.fn((...args: unknown[]) => ({
      first: vi.fn().mockResolvedValue(args.length === 1 ? {
        id: 3, name: '个人邮箱', email_address: 'me@example.com', rule_count: 0,
      } : null),
      run,
    }));
    const prepare = vi.fn(() => ({ bind }));

    const response = await ruleRoutes.request('/forward/7', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: ' inbox ', destination_id: 3 }),
    }, { DB: { prepare } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(prepare.mock.calls.some(([query]) => String(query).includes('UPDATE forward_rules'))).toBe(true);
    expect(bind).toHaveBeenCalledWith('inbox', 3, '7');
  });

  it.each([
    [{ prefix: 'bad prefix', destination_id: 3 }, '前缀只能是 *，或包含字母、数字、点、下划线和连字符'],
    [{ prefix: 'inbox' }, '请选择邮件目标'],
  ])('rejects invalid input', async (payload, message) => {
    const prepare = vi.fn();
    const response = await ruleRoutes.request('/forward/7', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, { DB: { prepare } });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('returns 404 when no rule was updated', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 0 } });
    const bind = vi.fn((...args: unknown[]) => ({
      first: vi.fn().mockResolvedValue(args.length === 1 ? {
        id: 3, name: '个人邮箱', email_address: 'me@example.com', rule_count: 0,
      } : null),
      run,
    }));
    const prepare = vi.fn(() => ({ bind }));

    const response = await ruleRoutes.request('/forward/999', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: 'inbox', destination_id: 3 }),
    }, { DB: { prepare } });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: '转发规则不存在' });
  });
});

describe('Rule prefix normalization', () => {
  // Incoming addresses are lower-cased by the parser and matched with `=`, so a
  // rule saved as "GitHub" would never fire unless it is stored lower-case too.
  it.each(['/forward', '/tg', '/bark'])('stores %s prefixes lower-cased', async (path) => {
    const inserted: unknown[][] = [];
    const db = {
      prepare: (query: string) => ({
        bind: (...values: unknown[]) => {
          if (query.startsWith('INSERT INTO') && !query.includes('audit_logs')) inserted.push(values);
          return {
            first: async () => ({
              id: 1, name: 'x', email_address: 'me@example.com', server_url: 'https://api.day.app',
              device_key: 'k', token: '1:x', username: 'bot',
            }),
            run: async () => ({ meta: { last_row_id: 1, changes: 1 } }),
          };
        },
      }),
    } as unknown as D1Database;
    const response = await ruleRoutes.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prefix: ' GitHub ', destination_id: 1, endpoint_id: 1, bot_id: 1, chat_id: '123',
      }),
    }, { DB: db });
    expect(response.status).toBe(201);
    expect(inserted[0][0]).toBe('github');
  });
});

describe('Routing activity', () => {
  it('reports the latest delivery per rule under the SPA channel names', async () => {
    const db = {
      prepare: (query: string) => ({ query, bind: () => ({ query }) }),
      batch: async () => [
        { results: [
          { channel: 'telegram', rule_id: 4, status: 'failed', last_error: 'chat not found', last_triggered_at: 't1' },
          { channel: 'forward', rule_id: 2, status: 'success', last_error: '', last_triggered_at: 't2' },
        ] },
        { results: [{ prefix: 'github', last_received_at: 't3', email_count: 7 }] },
      ],
    } as unknown as D1Database;
    const response = await ruleRoutes.request('/activity', {}, { DB: db });
    expect(await response.json()).toEqual({
      deliveries: [
        { channel: 'tg', rule_id: 4, status: 'failed', last_error: 'chat not found', last_triggered_at: 't1' },
        { channel: 'forward', rule_id: 2, status: 'success', last_error: '', last_triggered_at: 't2' },
      ],
      prefixes: [{ prefix: 'github', last_received_at: 't3', email_count: 7 }],
    });
  });
});
