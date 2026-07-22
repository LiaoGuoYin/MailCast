import { describe, expect, it } from 'vitest';
import { normalizeEmailDetail } from '../src/api/emails';

const baseEmail = {
  id: 1,
  from_addr: 'sender@example.com',
  to_addr: 'inbox@example.com',
  to_prefix: 'inbox',
  subject: 'Hello',
  text_body: 'Plain text',
  html_body: '<p>HTML</p>',
  body_truncated: 0,
  raw_body: 'Subject: Hello\r\n\r\nPlain text',
  raw_truncated: 0,
  downstream_recorded: 1,
  created_at: '2026-07-21T00:00:00.000Z',
};

describe('email detail', () => {
  it('returns stored bodies and normalizes numeric flags', () => {
    const detail = normalizeEmailDetail({
      ...baseEmail,
      body_truncated: 1,
      raw_truncated: 1,
      downstream_recorded: 0,
    });

    expect(detail.text_body).toBe('Plain text');
    expect(detail.html_body).toBe('<p>HTML</p>');
    expect(detail.body_truncated).toBe(true);
    expect(detail.raw_body).toContain('Subject: Hello');
    expect(detail.raw_truncated).toBe(true);
    expect(detail.downstream_recorded).toBe(false);
  });
});
