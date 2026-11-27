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
    const composeBtn = document.querySelector('.sidebar #emails-compose');
    expect(composeBtn).not.toBeNull();
    expect(composeBtn.querySelector('svg')).not.toBeNull();
    composeBtn.click();

    await vi.waitFor(() => {
      expect(document.querySelector('[data-compose-domain]').textContent).toBe('@mail.example.com');
    });
    expect(document.querySelector('[data-compose-warning]').hidden).toBe(true);

    const form = document.querySelector('.compose-email-form');
    const toggleBtn = form.querySelector('[data-compose-prefix-toggle]');
    expect(toggleBtn.hidden).toBe(false);
    toggleBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    const options = form.querySelectorAll('[data-prefix-option]');
    expect(options).toHaveLength(2);
    form.querySelector('[data-prefix-option="hi"]').dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );
    expect(form.querySelector('#compose-prefix').value).toBe('hi');
    expect(form.querySelector('[data-compose-menu]').hidden).toBe(true);

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

  it('exposes a direct reply button in the reader top bar on detail open', async () => {
    const fetchMock = vi.fn((url) => {
      if (String(url).startsWith('/api/emails?')) {
        return json({
          data: [{
            id: 7,
            from_addr: 'bounce@github.com',
            to_addr: 'github@example.com',
            to_prefix: 'github',
            subject: 'PR #1',
            snippet: 'Looks great',
            is_read: true,
            created_at: '2026-11-26T00:00:00Z',
          }],
          total: 1,
          unread_count: 0,
          page: 1,
          limit: 20,
        });
      }
      if (String(url) === '/api/emails/7') {
        return json({
          id: 7,
          from_addr: 'bounce@github.com',
          envelope_from: 'bounces+7@sgmail.github.com',
          reply_to_addr: 'reply@github.com',
          to_addr: 'github@example.com',
          to_prefix: 'github',
          subject: 'PR #1',
          text_body: 'Original body',
          html_body: '',
          body_truncated: false,
          raw_body: '',
          raw_truncated: false,
          downstream_recorded: true,
          is_read: true,
          created_at: '2026-11-26T00:00:00Z',
          replies: [],
        });
      }
      if (String(url) === '/api/emails/7/downstreams') {
        return json({ tracked: true, data: [] });
      }
      if (String(url) === '/api/outbound/context') {
        return json({
          configured: true,
          provider: 'resend',
          send_domain: 'example.com',
          receive_domain: 'example.com',
          prefixes: ['github'],
        });
      }
      return json({ data: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    await import('../public/app.js');
    const { emailsView } = await import('../public/emails-view.js');
    await emailsView.load();
    document.querySelector('.mail-row[data-id="7"]').click();

    await vi.waitFor(() => {
      expect(document.querySelector('.reader-bar-top [data-act="reply"]')).not.toBeNull();
    });
    expect(document.querySelector('.reader-bar-sub .reader-format-switch')).not.toBeNull();
    // The envelope sender is shown only because it differs from the header From.
    const meta = document.querySelector('.reader-meta-drawer').textContent;
    expect(meta).toContain('信封');
    expect(meta).toContain('bounces+7@sgmail.github.com');

    document.querySelector('.reader-bar-top [data-act="reply"]').click();
    await vi.waitFor(() => {
      expect(document.querySelector('.compose-email-form #compose-to')?.value).toBe('reply@github.com');
    });
    expect(document.querySelector('.compose-email-form #compose-prefix').value).toBe('github');
    expect(document.querySelector('.compose-email-form #compose-subject').value).toBe('Re: PR #1');
  });
});
