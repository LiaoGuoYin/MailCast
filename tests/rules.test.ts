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
