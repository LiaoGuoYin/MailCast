import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  parseEmail: vi.fn(),
  sendTgNotification: vi.fn(),
  extractCodeWithAI: vi.fn(),
  getAiConfig: vi.fn(),
  getEmailSenderAddress: vi.fn(),
}));

vi.mock('../src/email/parser', () => ({ parseEmail: mocks.parseEmail }));
vi.mock('../src/telegram/notify', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/telegram/notify')>(),
  sendTgNotification: mocks.sendTgNotification,
}));
vi.mock('../src/ai/extract', () => ({ extractCodeWithAI: mocks.extractCodeWithAI }));
vi.mock('../src/settings', () => ({
  getAiConfig: mocks.getAiConfig,
  getEmailSenderAddress: mocks.getEmailSenderAddress,
}));

import { handleEmail } from '../src/email/handler';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.parseEmail.mockResolvedValue({
    from_addr: 'sender@example.com',
    to_addr: 'alerts@example.com',
    to_prefix: 'alerts',
    subject: 'Build result',
    text_body: 'Build body',
    html_body: '<p>Build body</p>',
    body_truncated: 0,
    raw_body: 'Subject: Build result\r\n\r\nBuild body',
    raw_truncated: 0,
  });
  mocks.getAiConfig.mockResolvedValue({ provider: 'none' });
  mocks.getEmailSenderAddress.mockResolvedValue('forwarder@example.com');
  mocks.extractCodeWithAI.mockResolvedValue(null);
  mocks.sendTgNotification.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('incoming email downstream tracking', () => {
  it('records automatic email and Telegram outcomes against the inbox message', async () => {
    const statements: Array<{ query: string; args: unknown[] }> = [];
    let nextDownstreamId = 40;
    const db = {
      prepare: vi.fn((query: string) => ({
        bind: (...args: unknown[]) => {
          statements.push({ query, args });
          return {
            all: vi.fn().mockResolvedValue(query.includes('forward_rules')
              ? { results: [{ id: 3, prefix: 'alerts', target_email: 'next@example.com' }] }
              : query.includes('bark_rules') ? { results: [] } : { results: [{
                id: 8,
                prefix: 'alerts',
                chat_id: '-100123',
                bot_id: 5,
                bot_name: '验证码通知',
                bot_token: 'stored-bot-token',
              }] }),
            run: vi.fn().mockImplementation(async () => {
              if (query.includes('INSERT INTO emails\n')) {
                return { meta: { last_row_id: 12, changes: 1 } };
              }
              if (query.includes('INSERT INTO email_downstreams')) {
                return { meta: { last_row_id: ++nextDownstreamId, changes: 1 } };
              }
              return { meta: { last_row_id: 0, changes: 1 } };
            }),
          };
        },
      })),
    };
    const send = vi.fn().mockRejectedValue(Object.assign(new Error('mailbox unavailable'), {
        code: 'TEMPORARY_FAILURE',
      }));
    const message = { forward: vi.fn() };
    const background: Promise<unknown>[] = [];
    const ctx = { waitUntil: vi.fn((promise: Promise<unknown>) => background.push(promise)) };

    await handleEmail(message as never, { DB: db, EMAIL: { send } } as never, ctx as never);
    await Promise.all(background);

    const downstreamInserts = statements.filter(({ query }) => query.includes('INSERT INTO email_downstreams'));
    expect(downstreamInserts.map(({ args }) => args.slice(0, 7))).toEqual([
      [12, 'forward', 'rule', 3, 'next@example.com', null, ''],
      [12, 'telegram', 'rule', 8, '-100123', 5, '验证码通知'],
    ]);

    const outcomes = statements
      .filter(({ query }) => query.includes('UPDATE email_downstreams'))
      .map(({ args }) => [args[0], args[3], args[4]]);
    expect(outcomes).toEqual([
      ['failed', 41, 1],
      ['success', 42, 1],
    ]);
    expect(statements.some(({ query, args }) => (
      query.includes('UPDATE emails SET downstream_recorded = 1') && args[0] === 12
    ))).toBe(true);
    expect(message.forward).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      from: { email: 'forwarder@example.com', name: 'MailCast' },
      to: 'next@example.com',
    }));
    expect(mocks.sendTgNotification).toHaveBeenCalledWith('stored-bot-token', '-100123', {
      from: 'sender@example.com',
      to: 'alerts@example.com',
      subject: 'Build result',
      body: 'Build body',
      code: null,
    });
  });
});
