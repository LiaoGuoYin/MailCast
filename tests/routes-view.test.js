import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROUTES_VIEW_KEY, TOKEN_KEY } from '../public/storage.js';

const BODY = readFileSync('public/index.html', 'utf8')
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');

function json(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

const ROUTES = {
  '/api/rules/forward': [
    { id: 1, prefix: 'github', destination_id: 1, destination_name: 'iCloud', target_email: 'me@icloud.com', enabled: 1 },
    { id: 2, prefix: '*', destination_name: 'Archive', target_email: 'a@x.com', enabled: 1 },
  ],
  '/api/rules/tg': [{ id: 7, prefix: 'github', chat_id: '123', bot_id: 3, bot_name: 'Bot', enabled: 1 }],
  '/api/rules/bark': [],
  '/api/rules/activity': {
    deliveries: [{ channel: 'tg', rule_id: 7, status: 'failed', last_error: 'chat not found', last_triggered_at: '2026-01-01 00:00:00' }],
    prefixes: [{ prefix: 'shopping', last_received_at: '2026-01-01 00:00:00', email_count: 2 }],
  },
  '/api/setup': { receiving: { done: true, domain: 'mail.example.com' }, rules: { done: true, count: 3 }, sending: { done: true, required: true }, complete: true },
  '/api/settings': { mail_domain: 'mail.example.com', ai: {}, email_sender: { source: 'automatic' } },
  '/api/destinations/emails': { data: [{ id: 1, name: 'iCloud', email_address: 'me@icloud.com' }] },
};

function stubFetch(onPost = () => json({})) {
  const fetchMock = vi.fn((url, options = {}) => {
    const path = String(url).split('?')[0];
    if (options.method === 'POST') return onPost(path, JSON.parse(options.body));
    return json(path in ROUTES ? ROUTES[path] : { data: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function bootAt(hash) {
  // replaceState, not location.hash: happy-dom treats a hash assignment as a
  // navigation and fetches the page from its default origin.
  history.replaceState(null, '', hash);
  await import('../public/app.js');
}

describe('routing view', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem(TOKEN_KEY, 'token');
    document.body.innerHTML = BODY;
  });

  afterEach(() => {
    // Requests still in flight from this test's views must not fall through to
    // the real fetch once the stub is removed, so park them instead.
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    history.replaceState(null, '', '/');
  });

  it('lists every address with its own and inherited outlets', async () => {
    stubFetch();
    await bootAt('#rules');
    await vi.waitFor(() => expect(document.querySelectorAll('.route-row')).toHaveLength(3));

    const rows = [...document.querySelectorAll('.route-row')];
    expect(rows.map((row) => row.querySelector('.route-address').textContent))
      .toEqual(['github@mail.example.com', 'shopping@mail.example.com', '其他所有地址']);
    const github = rows[0];
    expect(github.classList).toContain('has-failure');
    expect(github.querySelector('.route-chip.is-failed').textContent).toContain('123');
    expect(github.querySelector('.route-chip.is-inherited').textContent).toContain('Archive');
    expect(rows[1].querySelector('.route-chip.is-inherited')).not.toBeNull();
  });

  it('expands a route and prefills the composer from its add button', async () => {
    stubFetch();
    await bootAt('#rules');
    await vi.waitFor(() => expect(document.querySelector('[data-route-toggle="github"]')).not.toBeNull());

    const head = document.querySelector('[data-route-toggle="github"]');
    head.click();
    expect(head.getAttribute('aria-expanded')).toBe('true');
    const body = head.closest('.route-row').querySelector('.route-body');
    expect(body.hidden).toBe(false);
    expect(body.textContent).toContain('chat not found');

    body.querySelector('[data-add-prefix]').click();
    expect(document.querySelector('#rules-composer').hidden).toBe(false);
    expect(document.querySelector('#rules-compose-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('#rule-prefix').value).toBe('github');
  });

  it('switches to the graph, remembers it, and opens the existing forms from it', async () => {
    stubFetch();
    await bootAt('#rules');
    await vi.waitFor(() => expect(document.querySelectorAll('.route-row')).toHaveLength(3));

    document.querySelector('[data-routes-view="graph"]').click();
    expect(localStorage.getItem(ROUTES_VIEW_KEY)).toBe('graph');
    expect(document.querySelector('#rules-panel').dataset.view).toBe('graph');
    const graph = document.querySelector('#rules-graph');
    expect([...graph.querySelectorAll('[data-graph-source]')].map((node) => node.dataset.graphSource))
      .toEqual(['github', '*']);
    expect([...graph.querySelectorAll('[data-graph-unrouted]')].map((node) => node.dataset.graphUnrouted))
      .toEqual(['shopping']);
    expect(graph.querySelectorAll('.graph-edge')).toHaveLength(3);

    // A curve is a rule: it opens the edit form for that rule.
    graph.querySelector('[data-graph-edge="tg:7"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('#edit-rule-value').value).toBe('123');
    document.querySelector('.edit-rule-form [data-act="close"]').click();

    // An outlet opens the composer aimed at it, leaving the prefix to the customer.
    graph.querySelector('[data-graph-outlet="forward:1"]').click();
    expect(document.querySelector('#rules-composer').hidden).toBe(false);
    expect(document.querySelector('#rule-channel').value).toBe('forward');
    expect(document.querySelector('#rule-target').value).toBe('1');

    graph.querySelector('[data-graph-unrouted="shopping"]').click();
    expect(document.querySelector('#rule-prefix').value).toBe('shopping');
  });

  it('opens on the graph when it was the last view used', async () => {
    localStorage.setItem(ROUTES_VIEW_KEY, 'graph');
    stubFetch();
    await bootAt('#rules');
    await vi.waitFor(() => expect(document.querySelectorAll('#rules-graph [data-graph-source]')).toHaveLength(2));
    expect(document.querySelector('[data-routes-view="graph"]').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('sender test email', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem(TOKEN_KEY, 'token');
    document.body.innerHTML = BODY;
  });

  afterEach(() => {
    // Requests still in flight from this test's views must not fall through to
    // the real fetch once the stub is removed, so park them instead.
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    history.replaceState(null, '', '/');
  });

  it('confirms the sender address on success', async () => {
    stubFetch(() => json({ success: true, from_address: 'forwarder@mail.example.com' }));
    await bootAt('#settings');
    await vi.waitFor(() => expect(document.querySelector('#email-sender-test')).not.toBeNull());

    document.querySelector('#email-sender-test').click();
    document.querySelector('#sender-test-to').value = 'me@example.com';
    document.querySelector('#sender-test-form').dispatchEvent(new Event('submit', { cancelable: true }));

    const result = document.querySelector('#sender-test-result');
    await vi.waitFor(() => expect(result.hidden).toBe(false));
    expect(result.classList).toContain('is-success');
    expect(result.textContent).toContain('forwarder@mail.example.com');
  });

  it('suggests the first destination and reports the failure reason inline', async () => {
    const fetchMock = stubFetch(() => json({ error: '发送失败：domain is not verified' }, 502));
    await bootAt('#settings');
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/destinations/emails'))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve));

    document.querySelector('#email-sender-test').click();
    const input = document.querySelector('#sender-test-to');
    expect(input.value).toBe('me@icloud.com');

    document.querySelector('#sender-test-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector('#sender-test-result').hidden).toBe(false));

    const post = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(post[0]).toBe('/api/settings/email-sender/test');
    expect(JSON.parse(post[1].body)).toEqual({ to: 'me@icloud.com' });
    expect(document.querySelector('#sender-test-result').textContent).toContain('domain is not verified');
  });
});
