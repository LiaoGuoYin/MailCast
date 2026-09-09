import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BODY = readFileSync('public/index.html', 'utf8')
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');

const EMAIL_TARGETS = [{ id: 1, name: '个人邮箱', email_address: 'me@example.com', rule_count: 0 }];
const BARK_ENDPOINTS = [{ id: 7, name: '手机', key_hint: 'abcd', rule_count: 0 }];
const TELEGRAM_BOTS = [{ id: 9, name: '通知机器人', username: 'notify_bot' }];

const FULL_CATALOG = {
  '/destinations/emails': { data: EMAIL_TARGETS },
  '/destinations/bark': { data: BARK_ENDPOINTS },
  '/settings/telegram-bots': { data: TELEGRAM_BOTS },
};

// Any path the test did not name answers with an empty catalog, so booting the
// module (which fetches on its own) cannot fail a test about something else.
function stubFetch(table) {
  vi.stubGlobal('fetch', vi.fn((url) => {
    const path = String(url).replace(/^\/api/, '');
    const body = Object.prototype.hasOwnProperty.call(table, path) ? table[path] : { data: [] };
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }));
}

async function boot(table) {
  stubFetch(table);
  return import('../public/app.js');
}

const select = (id) => document.querySelector(id);

describe('rule form selects', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = BODY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fills each select from its own catalog', async () => {
    const app = await boot(FULL_CATALOG);
    await app.loadDestinationCatalogs();
    await app.loadTelegramBotCatalog();

    expect(select('#rule-target').innerHTML).toContain('me@example.com');
    expect(select('#rule-bark').innerHTML).toContain('••••abcd');
    expect(select('#rule-bot').innerHTML).toContain('notify_bot');
  });

  it('disables a select when its container is hidden, whatever the catalog holds', async () => {
    const app = await boot(FULL_CATALOG);
    await app.loadDestinationCatalogs();
    await app.loadTelegramBotCatalog();

    // The forward fields are the default channel and are visible; bark and tg are not.
    expect(select('#rule-target').closest('[data-channel-fields]').hidden).toBe(false);
    expect(select('#rule-target').disabled).toBe(false);
    expect(select('#rule-bark').disabled).toBe(true);
    expect(select('#rule-bot').disabled).toBe(true);
  });

  it('disables a visible select when its catalog is empty', async () => {
    const app = await boot({ '/destinations/emails': { data: [] } });
    await app.loadDestinationCatalogs();

    expect(select('#rule-target').closest('[data-channel-fields]').hidden).toBe(false);
    expect(select('#rule-target').disabled).toBe(true);
    expect(select('#rule-target').innerHTML).toContain('请先添加邮件目标');
  });

  it('keeps the current selection when a catalog reloads', async () => {
    const app = await boot(FULL_CATALOG);
    await app.loadDestinationCatalogs();
    select('#rule-target').value = '1';

    await app.loadDestinationCatalogs();

    expect(select('#rule-target').value).toBe('1');
    expect(select('#rule-target').innerHTML).toContain('selected');
  });

  // Switching channel re-derives the same "is this catalog empty" answer that
  // the sync functions use, but keys it off the channel being activated rather
  // than the container's current hidden state.
  it('keeps a select disabled when its channel is activated but the catalog is empty', async () => {
    const app = await boot({
      '/destinations/emails': { data: EMAIL_TARGETS },
      '/destinations/bark': { data: [] },
      '/settings/telegram-bots': { data: TELEGRAM_BOTS },
    });
    await app.loadDestinationCatalogs();
    await app.loadTelegramBotCatalog();

    const channel = select('#rule-channel');
    channel.value = 'bark';
    channel.dispatchEvent(new Event('change'));

    expect(select('#rule-bark').closest('[data-channel-fields]').hidden).toBe(false);
    expect(select('#rule-bark').disabled).toBe(true);

    channel.value = 'tg';
    channel.dispatchEvent(new Event('change'));

    expect(select('#rule-bot').closest('[data-channel-fields]').hidden).toBe(false);
    expect(select('#rule-bot').disabled).toBe(false);
  });

  // The two catalogs load at different times from different callers. Each loader
  // must touch only the selects it owns, or a quick-forward flow that refreshes
  // the bots would silently reset a half-filled rule form.
  it('leaves the destination selects untouched when only the bot catalog reloads', async () => {
    const app = await boot(FULL_CATALOG);
    await app.loadDestinationCatalogs();
    select('#rule-target').value = '1';
    const targetBefore = select('#rule-target').innerHTML;
    const barkBefore = select('#rule-bark').innerHTML;

    await app.loadTelegramBotCatalog();

    expect(select('#rule-target').innerHTML).toBe(targetBefore);
    expect(select('#rule-target').value).toBe('1');
    expect(select('#rule-bark').innerHTML).toBe(barkBefore);
    expect(select('#rule-bot').innerHTML).toContain('notify_bot');
  });
});
