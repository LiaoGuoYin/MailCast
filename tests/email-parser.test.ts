import { describe, expect, it } from 'vitest';
import {
  HTML_BODY_LIMIT_BYTES,
  RAW_BODY_LIMIT_BYTES,
  TEXT_BODY_LIMIT_BYTES,
  parseRawEmail,
  truncateUtf8,
} from '../src/email/parser';

describe('email parser', () => {
  it('keeps text and HTML alternatives separately', async () => {
    const raw = [
      'From: Sender <sender@example.com>',
      'To: github@example.com',
      'Subject: Verify your account',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="mail-boundary"',
      '',
      '--mail-boundary',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Your code is 482913.',
      '--mail-boundary',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><body><strong>Your code is 482913.</strong></body></html>',
      '--mail-boundary--',
    ].join('\r\n');

    const parsed = await parseRawEmail(raw, 'sender@example.com', 'GitHub@example.com');

    expect(parsed.to_prefix).toBe('github');
    expect(parsed.text_body).toContain('482913');
    expect(parsed.html_body).toContain('<strong>');
    expect(parsed.body_truncated).toBe(0);
    expect(parsed.raw_body).toBe(raw);
    expect(parsed.raw_truncated).toBe(0);
  });

  it('stores the header From and keeps the envelope sender separately', async () => {
    // Shape of a Resend/SES delivery: the envelope sender is a per-message VERP bounce address.
    const raw = [
      'From: MailCast <resend@example.com>',
      'To: i@example.com',
      'Subject: Hello',
      '',
      'Body',
    ].join('\r\n');

    const parsed = await parseRawEmail(raw, '0106abc-000000@send.example.com', 'i@example.com');

    expect(parsed.from_addr).toBe('resend@example.com');
    expect(parsed.envelope_from).toBe('0106abc-000000@send.example.com');
  });

  it('falls back to the envelope sender when the header From is missing or unusable', async () => {
    const missing = await parseRawEmail('Subject: No from\r\n\r\nBody', 'sender@example.com', 'i@example.com');
    const invalid = await parseRawEmail('From: undisclosed\r\nSubject: Bad\r\n\r\nBody', 'sender@example.com', 'i@example.com');

    expect(missing.from_addr).toBe('sender@example.com');
    expect(invalid.from_addr).toBe('sender@example.com');
    expect(invalid.envelope_from).toBe('sender@example.com');
  });

  it('supports HTML-only and empty messages', async () => {
    const html = await parseRawEmail(
      'Subject: HTML only\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body>Hello</body></html>',
      'sender@example.com',
      'news@example.com',
    );
    const empty = await parseRawEmail('Subject: Empty\r\n\r\n', 'sender@example.com', 'empty@example.com');

    expect(html.text_body).toBe('');
    expect(html.html_body).toContain('<html>');
    expect(empty.text_body).toBe('');
    expect(empty.html_body).toBe('');
  });

  it('truncates UTF-8 without splitting a multibyte character', () => {
    const value = 'a'.repeat(TEXT_BODY_LIMIT_BYTES - 2) + '你' + 'tail';
    const result = truncateUtf8(value, TEXT_BODY_LIMIT_BYTES);

    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(result.value).byteLength).toBeLessThanOrEqual(TEXT_BODY_LIMIT_BYTES);
    expect(result.value).not.toContain('\ufffd');
  });

  it('uses independent text and HTML byte budgets', () => {
    expect(TEXT_BODY_LIMIT_BYTES).toBe(512 * 1024);
    expect(HTML_BODY_LIMIT_BYTES).toBe(1024 * 1024);
    expect(RAW_BODY_LIMIT_BYTES).toBe(256 * 1024);
  });

  it('truncates stored raw source independently from parsed bodies', async () => {
    const raw = `Subject: Large raw\r\n\r\n${'a'.repeat(RAW_BODY_LIMIT_BYTES + 64)}`;
    const parsed = await parseRawEmail(raw, 'sender@example.com', 'raw@example.com');

    expect(new TextEncoder().encode(parsed.raw_body).byteLength).toBe(RAW_BODY_LIMIT_BYTES);
    expect(parsed.raw_truncated).toBe(1);
  });
});
