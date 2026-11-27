import { describe, expect, it } from 'vitest';
import { createSetupGuide, setupSteps } from '../web/setup-guide.js';
import { SETUP_GUIDE_DISMISSED_KEY } from '../web/storage.js';

const status = (overrides = {}) => ({
  receiving: { done: false, domain: '' },
  rules: { done: false, count: 0 },
  sending: { done: false, required: false, provider: 'resend' },
  complete: false,
  ...overrides,
});

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)) };
}

describe('setup guide', () => {
  it('treats sending as optional until a rule forwards to a mailbox', () => {
    expect(setupSteps(status()).map((step) => step.state)).toEqual(['todo', 'todo', 'optional']);
    const required = status({ sending: { done: false, required: true, provider: 'resend' } });
    expect(setupSteps(required)[2]).toMatchObject({ state: 'todo', action: { href: '#settings' } });
  });

  it('names the receiving domain once mail has arrived', () => {
    const [receiving] = setupSteps(status({ receiving: { done: true, domain: 'mail.example.com' } }));
    expect(receiving).toMatchObject({ state: 'done', action: null });
    expect(receiving.body).toContain('@mail.example.com');
  });

  it('renders until complete and stays hidden once dismissed', async () => {
    const root = document.createElement('section');
    root.hidden = true;
    const storage = memoryStorage();
    let current = status();
    const guide = createSetupGuide({ api: async () => current, root, storage });
    guide.init();

    await guide.load();
    expect(root.hidden).toBe(false);
    expect(root.querySelectorAll('.setup-step')).toHaveLength(3);
    expect(root.textContent).toContain('完成 0/2 步');

    current = status({ complete: true });
    await guide.load();
    expect(root.hidden).toBe(true);

    current = status();
    await guide.load();
    root.querySelector('[data-setup-dismiss]').click();
    expect(root.hidden).toBe(true);
    expect(storage.getItem(SETUP_GUIDE_DISMISSED_KEY)).toBe('1');
    await guide.load();
    expect(root.hidden).toBe(true);
  });

  it('leaves the inbox alone when the status request fails', async () => {
    const root = document.createElement('section');
    root.hidden = true;
    const guide = createSetupGuide({ api: async () => { throw new Error('down'); }, root, storage: memoryStorage() });
    await guide.load();
    expect(root.hidden).toBe(true);
  });
});
