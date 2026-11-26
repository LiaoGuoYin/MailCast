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

function submit(form) {
  form.dispatchEvent(new Event('submit', { cancelable: true }));
}

describe('compose and reply modal', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = BODY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads outbound context, previews cross-domain Reply-To, and sends a composed email', async () => {
    const fetchMock = vi.fn((url, options = {}) => {
      if (String(url) === '/api/outbound/context') {
        return json({
          configured: true,
          provider: 'resend',
          send_domain: 'mail.example.com',
          receive_domain: 'example.com',
          prefixes: ['github', 'hi'],
        });
      }
      if (String(url) === '/api/outbound/send' && options.method === 'POST') {
        return json({
          success: true,
          id: 12,
          message_id: 're_12',
          from: 'hi@mail.example.com',
          reply_to: 'hi@example.com',
          sent: { id: 12, from_addr: 'hi@mail.example.com', to_addr: 'bob@example.net', status: 'success' },
        });
      }
      return json({ data: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('../public/app.js');
    document.querySelector('#emails-compose').click();

    await vi.waitFor(() => {
      expect(document.querySelectorAll('#compose-prefix-list option')).toHaveLength(2);
    });

    const form = document.querySelector('.compose-email-form');
    const prefixInput = form.querySelector('#compose-prefix');
    prefixInput.value = 'hi';
    prefixInput.dispatchEvent(new Event('input'));

    const preview = form.querySelector('[data-compose-preview]').textContent;
    expect(preview).toContain('hi <hi@mail.example.com>');
    expect(preview).toContain('hi@example.com');

    form.querySelector('#compose-to').value = 'bob@example.net';
    form.querySelector('#compose-subject').value = 'Hello';
    form.querySelector('#compose-text').value = 'Nice to meet you';

    submit(form);

    await vi.waitFor(() => {
      expect(document.querySelector('#toast-root').textContent).toContain('hi@mail.example.com');
    });

    const sendCall = fetchMock.mock.calls.find(([url, opt]) => String(url) === '/api/outbound/send' && opt?.method === 'POST');
    expect(JSON.parse(sendCall[1].body)).toEqual({
      prefix: 'hi',
      to: 'bob@example.net',
      subject: 'Hello',
      text: 'Nice to meet you',
    });
  });

  it('disables submit and warns when outbound sending is not configured', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => {
      if (String(url) === '/api/outbound/context') {
        return json({
          configured: false,
          provider: 'resend',
          send_domain: '',
          receive_domain: 'example.com',
          prefixes: [],
        });
      }
      return json({ data: [] });
    }));

    await import('../public/app.js');
    document.querySelector('#emails-compose').click();

    await vi.waitFor(() => {
      expect(document.querySelector('[data-compose-warning]').hidden).toBe(false);
    });
    expect(document.querySelector('[data-compose-submit]').disabled).toBe(true);
  });

  it('prefills reply modal with prefix, reply_to_addr, Re: subject, and passes reply_to_email_id', async () => {
    const fetchMock = vi.fn((url, options = {}) => {
      if (String(url) === '/api/outbound/context') {
        return json({
          configured: true,
          provider: 'resend',
          send_domain: 'example.com',
          receive_domain: 'example.com',
          prefixes: ['github'],
        });
      }
      if (String(url) === '/api/outbound/send' && options.method === 'POST') {
        return json({
          success: true,
          id: 99,
          message_id: 're_99',
          from: 'github@example.com',
          reply_to: '',
          sent: { id: 99, from_addr: 'github@example.com', to_addr: 'reply@github.com', status: 'success', text_body: 'Thanks!', created_at: '2026-11-26T00:00:00Z' },
        });
      }
      return json({ data: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('../public/app.js');
    const { emailsView } = await import('../public/emails-view.js');
    const onSent = vi.fn();
    emailsView.openComposeModal({
      initialPrefix: 'github',
      initialTo: 'reply@github.com',
      initialSubject: 'Re: PR #1',
      initialText: '\n\n> original',
      replyToEmail: { id: 7, to_addr: 'github@example.com', from_addr: 'bounce@github.com', reply_to_addr: 'reply@github.com' },
      onSent,
    });

    await vi.waitFor(() => {
      expect(document.querySelector('[data-compose-preview]').textContent).toContain('github <github@example.com>');
    });

    const form = document.querySelector('.compose-email-form');
    form.querySelector('#compose-text').value = 'Thanks!\n\n> original';
    submit(form);

    await vi.waitFor(() => expect(onSent).toHaveBeenCalledOnce());

    const sendCall = fetchMock.mock.calls.find(([url, opt]) => String(url) === '/api/outbound/send' && opt?.method === 'POST');
    expect(JSON.parse(sendCall[1].body)).toEqual({
      prefix: 'github',
      to: 'reply@github.com',
      subject: 'Re: PR #1',
      text: 'Thanks!\n\n> original',
      reply_to_email_id: 7,
    });
  });
});
