import { describe, expect, it, vi } from 'vitest';
import { emailRoutes } from '../src/api/emails';
import {
  buildForwardedEmail,
  emailSendErrorPayload,
  forwardedSubject,
  validateEmailAddress,
} from '../src/email/forward';

const email = {
  id: 7,
  from_addr: 'sender@example.com',
  to_addr: 'inbox@example.com',
  to_prefix: 'inbox',
  subject: 'Original subject',
  text_body: 'Plain body',
  html_body: '<p>HTML body</p>',
  body_truncated: false,
  raw_body: 'Subject: Original subject\r\n\r\nPlain body',
  raw_truncated: false,
  created_at: '2026-07-21T00:00:00.000Z',
};

describe('quick email forwarding', () => {
  it('validates a single recipient and rejects header injection', () => {
    expect(validateEmailAddress('next@example.com')).toBeNull();
    expect(validateEmailAddress('')).toContain('请输入');
    expect(validateEmailAddress('next@example.com\nBcc: victim@example.com')).toContain('有效');
    expect(validateEmailAddress('not-an-address')).toContain('有效');
  });

  it('adds a forwarding subject prefix only once', () => {
    expect(forwardedSubject('Original')).toBe('Fwd: Original');
    expect(forwardedSubject('Fwd: Original')).toBe('Fwd: Original');
    expect(forwardedSubject('FW: Original')).toBe('FW: Original');
  });

  it('builds text and HTML variants with original metadata and body', () => {
    const result = buildForwardedEmail(email);

    expect(result.subject).toBe('Fwd: Original subject');
    expect(result.text).toContain('From: sender@example.com');
    expect(result.text).toContain('Plain body');
    expect(result.html).toContain('From: sender@example.com');
    expect(result.html).toContain('<p>HTML body</p>');
  });

  it('makes stored-body truncation explicit to the forwarded recipient', () => {
    const result = buildForwardedEmail({ ...email, body_truncated: true });

    expect(result.text).toContain('原邮件正文因存储上限已截断');
    expect(result.html).toContain('原邮件正文因存储上限已截断');
  });

  it('returns bounded safe details for binding errors', () => {
    const error = Object.assign(new Error('Domain not onboarded'), {
      code: 'E_SENDER_DOMAIN_NOT_AVAILABLE',
    });
    const payload = emailSendErrorPayload(error);

    expect(payload).toEqual({
      error: '邮件转发失败',
      email: {
        code: 'E_SENDER_DOMAIN_NOT_AVAILABLE',
        description: 'Domain not onboarded',
      },
    });
  });

  it('sends through the Email binding from the fixed configured sender', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'message-123' });
    const first = vi.fn().mockResolvedValue({ ...email, body_truncated: 0, raw_truncated: 0 });
    const run = vi.fn()
      .mockResolvedValueOnce({ meta: { last_row_id: 33, changes: 1 } })
      .mockResolvedValue({ meta: { last_row_id: 0, changes: 1 } });
    const env = {
      DB: { prepare: vi.fn(() => ({ bind: () => ({ first, run }) })) },
      EMAIL: { send },
      EMAIL_FROM_ADDRESS: 'forwarder@liaoguoyin.com',
    };

    const response = await emailRoutes.request('/7/forward', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'next@example.com' }),
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      message_id: 'message-123',
      downstream_id: 33,
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      from: { email: 'forwarder@liaoguoyin.com', name: 'MailCast' },
      to: 'next@example.com',
      subject: 'Fwd: Original subject',
    }));
  });

  it('rejects invalid recipients before reading or sending email data', async () => {
    const prepare = vi.fn();
    const send = vi.fn();
    const response = await emailRoutes.request('/7/forward', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'bad address' }),
    }, {
      DB: { prepare },
      EMAIL: { send },
      EMAIL_FROM_ADDRESS: 'forwarder@liaoguoyin.com',
    });

    expect(response.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
