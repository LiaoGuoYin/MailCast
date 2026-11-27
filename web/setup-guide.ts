// "开始使用" card on the inbox. Derives every step from GET /api/setup so the
// customer never has to tick anything off: the card fills itself in as mail
// arrives and rules are saved, and disappears once setup is complete.
import type { SetupStatus } from './api-types.js';
import { SETUP_GUIDE_DISMISSED_KEY } from './storage.js';

const CLOUDFLARE_EMAIL_ROUTING_URL = 'https://dash.cloudflare.com/?to=/:account/:zone/email/routing/routes';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

export interface SetupStep {
  id: 'receiving' | 'rules' | 'sending';
  // "optional" steps never block completion.
  state: 'done' | 'todo' | 'optional';
  title: string;
  body: string;
  action: { label: string; href: string; external?: boolean } | null;
}

export interface SetupGuideOptions {
  api: (path: string) => Promise<SetupStatus>;
  root: HTMLElement;
  storage?: Storage;
}

// Returns the steps to show.
export function setupSteps(status: SetupStatus): SetupStep[] {
  const { receiving, rules, sending } = status;
  return [
    {
      id: 'receiving',
      state: receiving.done ? 'done' : 'todo',
      title: '把邮件接入 MailCast',
      body: receiving.done
        ? `已收到发往 @${receiving.domain} 的邮件。`
        : '在 Cloudflare 控制台打开域名的「电子邮件路由」，把 Catch-all 设为「发送到 Worker」并选择 MailCast，然后从任意邮箱给 test@你的域名 发一封邮件。',
      action: receiving.done ? null : { label: '打开 Cloudflare', href: CLOUDFLARE_EMAIL_ROUTING_URL, external: true },
    },
    {
      id: 'rules',
      state: rules.done ? 'done' : 'todo',
      title: '决定邮件送到哪里',
      body: rules.done
        ? `已有 ${rules.count} 条启用的路由规则。`
        : '新建一条规则，例如让 github@ 的邮件推送到 Telegram，或转发到你的常用邮箱。',
      action: rules.done ? null : { label: '新建规则', href: '#rules' },
    },
    {
      id: 'sending',
      state: sending.done ? 'done' : sending.required ? 'todo' : 'optional',
      title: '配置邮件发送',
      body: sending.done
        ? '发送服务已配置，转发到邮箱的规则可以正常投递。'
        : sending.required
          ? '你有转发到邮箱的规则，需要先配置 Resend API Key 或 Cloudflare 邮件发送，否则转发会失败。'
          : '只在需要把邮件转发到其他邮箱时配置；Telegram 和 Bark 不需要。',
      action: sending.done ? null : { label: '去配置', href: '#settings' },
    },
  ];
}

export function renderSetupGuide(status: SetupStatus): string {
  const steps = setupSteps(status);
  const required = steps.filter((step) => step.state !== 'optional');
  const done = required.filter((step) => step.state === 'done').length;
  // Only the next step to do gets the ink button, so the guide has one clear call to action.
  const nextId = steps.find((step) => step.state === 'todo')?.id;
  return `
    <div class="setup-guide-head">
      <div>
        <h2>开始使用 MailCast</h2>
        <p>完成 ${done}/${required.length} 步，每一步会在完成后自动打勾。</p>
      </div>
      <button type="button" class="icon-btn" data-setup-dismiss title="不再显示" aria-label="不再显示开始使用引导">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <ol class="setup-steps">
      ${steps.map((step, index) => `
        <li class="setup-step is-${step.state}" data-setup-step="${step.id}">
          <span class="setup-step-mark" aria-hidden="true">${step.state === 'done' ? '✓' : index + 1}</span>
          <div class="setup-step-text">
            <strong>${escapeHtml(step.title)}${step.state === 'optional' ? '<small>可选</small>' : ''}</strong>
            <p>${escapeHtml(step.body)}</p>
          </div>
          ${step.action ? `<a class="btn btn-sm${step.id === nextId ? ' btn-primary' : ''}" href="${escapeHtml(step.action.href)}"${step.action.external ? ' target="_blank" rel="noopener"' : ''}>${escapeHtml(step.action.label)}</a>` : ''}
          <span class="sr-only">${step.state === 'done' ? '已完成' : step.state === 'optional' ? '可选' : '未完成'}</span>
        </li>`).join('')}
    </ol>`;
}

export function createSetupGuide({ api, root, storage = localStorage }: SetupGuideOptions) {
  let seq = 0;

  async function load() {
    if (storage.getItem(SETUP_GUIDE_DISMISSED_KEY)) {
      root.hidden = true;
      return;
    }
    const my = ++seq;
    let status: SetupStatus;
    try {
      status = await api('/setup');
    } catch {
      // The card is a convenience; the inbox must work without it.
      return;
    }
    if (my !== seq) return;
    root.hidden = status.complete;
    if (!status.complete) root.innerHTML = renderSetupGuide(status);
  }

  function init() {
    root.addEventListener('click', (event) => {
      if (!(event.target as Element).closest('[data-setup-dismiss]')) return;
      storage.setItem(SETUP_GUIDE_DISMISSED_KEY, '1');
      root.hidden = true;
    });
  }

  return { load, init };
}
