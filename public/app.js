import { migrateLegacyStorage, THEME_KEY, TOKEN_KEY } from './storage.js';
import { emailsView } from './emails-view.js';
import { rulesView } from './rules-view.js';
import { logsView } from './logs-view.js';
import { settingsView } from './settings-view.js';

// ═══════════════════════════════════════════════
// MailCast — console app
// ═══════════════════════════════════════════════

const $ = (sel, root = document) => root.querySelector(sel);
const GITHUB_REPOSITORY_URL = 'https://github.com/LiaoGuoYin/MailCast';

// ── Icons ──

const ICONS = {
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A9.8 9.8 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15.5 7.5 3 3L22 7l-3-3"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
  forward: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 17 5-5-5-5"/><path d="M20 12H9a5 5 0 0 0-5 5v2"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
};

// ── Utilities ──

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// SQLite datetime() is UTC without timezone marker
function parseDate(str) {
  if (!str) return null;
  const d = new Date(str.includes('T') ? str : str.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

function fullTime(str) {
  const d = parseDate(str);
  if (!d) return str || '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function relTime(str) {
  const d = parseDate(str);
  if (!d) return str || '';
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function copyText(text, label = '内容') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`${label}已复制`, 'success');
}

// Heuristic: pick out a verification code when the mail looks like one
function extractCode(email) {
  const text = `${email.subject || ''}\n${email.text_body || email.body_preview || email.html_body || ''}`;
  if (!/(验证码|校验码|动态密码|verification|verify|security code|one[- ]?time|otp|passcode|激活码)/i.test(text)) return null;
  // reject digits that are part of a larger number/IP/date, but allow a
  // sentence-ending "." right after the code
  const m = text.match(/(?<![\d.-])(\d{4,8})(?!\d|[.-]\d)/);
  return m ? m[1] : null;
}

// ── Toast ──

function toast(message, type = 'info') {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const icon = type === 'success' ? ICONS.check : type === 'error' ? ICONS.alert : '';
  el.innerHTML = `${icon}<span>${escapeHtml(message)}</span>`;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 2800);
}

// ── Modal ──

let openOverlay = null;

function openModal(contentHtml, { small = false, wide = false } = {}) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const sizeClass = small ? ' modal-sm' : wide ? ' modal-wide' : '';
  overlay.innerHTML = `<div class="modal${sizeClass}" role="dialog" aria-modal="true">${contentHtml}</div>`;
  $('#modal-root').appendChild(overlay);
  openOverlay = overlay;

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeModal();
  });
  requestAnimationFrame(() => overlay.classList.add('open'));
  return overlay;
}

function closeModal() {
  if (!openOverlay) return;
  const overlay = openOverlay;
  openOverlay = null;
  overlay.dispatchEvent(new CustomEvent('modal-closed'));
  overlay.classList.remove('open');
  setTimeout(() => overlay.remove(), 200);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openOverlay) closeModal();
});

function confirmDialog({ title, message, confirmText = '删除' }) {
  return new Promise((resolve) => {
    const overlay = openModal(`
      <div class="modal-header"><h3 class="modal-title">${escapeHtml(title)}</h3></div>
      <div class="modal-body"><p class="modal-text">${escapeHtml(message)}</p></div>
      <div class="modal-footer">
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn btn-danger" data-act="ok">${escapeHtml(confirmText)}</button>
      </div>
    `, { small: true });

    let settled = false;
    const settle = (val) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(val);
    };
    // covers Escape and overlay clicks handled by openModal/closeModal
    overlay.addEventListener('modal-closed', () => settle(false));
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => settle(false));
    overlay.querySelector('[data-act="ok"]').addEventListener('click', () => settle(true));
    overlay.querySelector('[data-act="ok"]').focus();
  });
}

// ── API ──

class ApiError extends Error {
  constructor(message, status, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      ...opts,
      headers: {
        'Authorization': `Bearer ${getToken()}`,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
    });
  } catch {
    throw new ApiError('网络连接失败', 0);
  }
  if (res.status === 401) {
    forceLogout('登录已过期，请重新登录');
    throw new ApiError('Unauthorized', 401);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = body && typeof body.error === 'string'
      ? body.error
      : `请求失败（HTTP ${res.status}）`;
    throw new ApiError(message, res.status, body);
  }
  return res.json();
}

// ── Theme ──

function resolveTheme() {
  return localStorage.getItem(THEME_KEY)
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#theme-btn').innerHTML = theme === 'dark' ? ICONS.sun : ICONS.moon;
}

function initTheme() {
  applyTheme(resolveTheme());
  $('#theme-btn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}

// ── Panel states ──

function showState(stateEl, tableEl, html) {
  stateEl.innerHTML = html;
  stateEl.hidden = false;
  tableEl.style.display = 'none';
}

function showTable(stateEl, tableEl) {
  stateEl.hidden = true;
  tableEl.style.display = '';
}

function emptyStateHtml(icon, title, sub = '') {
  return `${icon}<span class="state-title">${escapeHtml(title)}</span>${sub ? `<span class="state-sub">${escapeHtml(sub)}</span>` : ''}`;
}

function errorStateHtml(message) {
  return `${ICONS.alert}<span class="state-title">加载失败</span><span class="state-sub">${escapeHtml(message)}</span><button class="btn btn-sm" data-retry>重试</button>`;
}

function renderSkeleton(tbody, widths, rows = 6) {
  tbody.innerHTML = Array.from({ length: rows }, () =>
    `<tr>${widths.map((w) => `<td><span class="skeleton" style="width:${w}"></span></td>`).join('')}</tr>`
  ).join('');
}

// ── Auth ──

function showLogin() {
  $('#app').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  $('#token-input').focus();
}

function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  loadedTabs.clear();
  loadActiveTab();
  if (activeTab !== 'emails') void emailsView.loadUnreadCount();
  void loadBuildMetadata();
}

let buildMetadataLoaded = false;

async function loadBuildMetadata() {
  if (buildMetadataLoaded) return;
  const link = $('#build-version-link');
  const fallback = $('#build-version-fallback');
  const time = $('#build-time');
  const separator = $('#build-time-separator');

  try {
    const response = await fetch('/api/meta');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const metadata = await response.json();
    const hasVersion = typeof metadata.app_version === 'string' && metadata.app_version;
    const hasCommit = typeof metadata.commit === 'string' && /^[0-9a-f]{12}$/.test(metadata.commit);

    if (hasVersion && hasCommit) {
      link.textContent = `v${metadata.app_version} · ${metadata.commit}`;
      link.href = `${GITHUB_REPOSITORY_URL}/commit/${metadata.commit}`;
      link.title = `打开 GitHub commit ${metadata.commit}`;
      link.hidden = false;
      fallback.hidden = true;
    } else {
      fallback.textContent = '未标记构建';
    }

    const deployedAt = parseDate(metadata.deployed_at);
    if (deployedAt) {
      const formatted = fullTime(metadata.deployed_at);
      time.dateTime = deployedAt.toISOString();
      time.textContent = `部署于 ${formatted}`;
      time.title = `Cloudflare deployment ${metadata.deployment_id || ''}`.trim();
      time.hidden = false;
      separator.hidden = false;
    }
    buildMetadataLoaded = true;
  } catch (error) {
    fallback.textContent = '版本不可用';
    console.error('Failed to load build metadata', error);
  }
}

function forceLogout(message) {
  if (!getToken() && $('#app').classList.contains('hidden')) return;
  localStorage.removeItem(TOKEN_KEY);
  closeModal();
  showLogin();
  if (message) toast(message, 'error');
}

function initAuth() {
  const form = $('#login-form');
  const input = $('#token-input');
  const btn = $('#login-btn');
  const errEl = $('#login-error');
  const toggle = $('#token-toggle');
  toggle.innerHTML = ICONS.eye;
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.innerHTML = show ? ICONS.eyeOff : ICONS.eye;
    input.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = input.value;
    if (!token) {
      input.focus();
      return;
    }
    errEl.hidden = true;
    btn.disabled = true;
    $('.btn-label', btn).textContent = '验证中…';
    $('.spinner', btn).classList.remove('hidden');

    let ok = false;
    let errMsg = '';
    let sessionToken = '';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: token }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        sessionToken = body.token || '';
        ok = Boolean(sessionToken);
      }
      else if (res.status === 401) errMsg = '管理密码无效，请检查后重试';
      else errMsg = typeof body.error === 'string' ? body.error : `服务异常（HTTP ${res.status}）`;
    } catch {
      errMsg = '无法连接服务器，请稍后重试';
    }

    btn.disabled = false;
    $('.btn-label', btn).textContent = '登录';
    $('.spinner', btn).classList.add('hidden');

    if (ok) {
      localStorage.setItem(TOKEN_KEY, sessionToken);
      input.value = '';
      showApp();
    } else if (errMsg) {
      errEl.textContent = errMsg;
      errEl.hidden = false;
      const box = $('.login-box');
      box.classList.remove('shake');
      void box.offsetWidth;
      box.classList.add('shake');
    }
  });

  $('#logout-btn').addEventListener('click', () => {
    const sessionToken = getToken();
    if (sessionToken) {
      void fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${sessionToken}` },
        keepalive: true,
      });
    }
    localStorage.removeItem(TOKEN_KEY);
    showLogin();
  });
}

// ── Tabs (hash-routed) ──

const TABS = ['emails', 'rules', 'destinations', 'logs', 'settings'];
let activeTab = 'emails';
const loadedTabs = new Set();
const DESTINATION_TABS = ['email', 'telegram', 'bark'];
let activeDestinationTab = 'email';

function switchDestinationTab(name, { focus = false } = {}) {
  const next = DESTINATION_TABS.includes(name) ? name : 'email';
  activeDestinationTab = next;
  document.querySelectorAll('[data-destination-tab]').forEach((tab) => {
    const selected = tab.dataset.destinationTab === next;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  });
  document.querySelectorAll('[data-destination-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.destinationPanel !== next;
  });
}

function initDestinationTabs() {
  const tablist = document.querySelector('.destination-channel-tabs');
  if (!tablist) return;
  tablist.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-destination-tab]');
    if (tab) switchDestinationTab(tab.dataset.destinationTab);
  });
  tablist.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = DESTINATION_TABS.indexOf(activeDestinationTab);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? DESTINATION_TABS.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + DESTINATION_TABS.length) % DESTINATION_TABS.length;
    switchDestinationTab(DESTINATION_TABS[next], { focus: true });
  });
  switchDestinationTab(activeDestinationTab);
}

function switchTab(name, { fromHash = false } = {}) {
  if (name === 'forward' || name === 'tg') {
    name = 'rules';
    if (fromHash) history.replaceState(null, '', '#rules');
  }
  if (!TABS.includes(name)) name = 'emails';
  activeTab = name;

  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.hidden = p.id !== `tab-${name}`;
    p.classList.toggle('active', p.id === `tab-${name}`);
  });

  if (!fromHash) history.replaceState(null, '', `#${name}`);
  loadActiveTab();
}

function loadActiveTab() {
  // never fire API calls while sitting on the login screen
  if ($('#app').classList.contains('hidden')) return;

  // inbox always refreshes on entry; rule lists are cached until mutated
  if (activeTab === 'emails') {
    emailsView.load();
    return;
  }
  if (activeTab === 'logs') {
    logsView.load();
    return;
  }
  if (loadedTabs.has(activeTab)) return;
  loadedTabs.add(activeTab);
  if (activeTab === 'rules') rulesView.load();
  else if (activeTab === 'destinations' || activeTab === 'settings') settingsView.load();
}

function initTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
  window.addEventListener('hashchange', () => {
    switchTab(location.hash.slice(1), { fromHash: true });
  });
  const initial = location.hash.slice(1) || activeTab;
  switchTab(initial, { fromHash: true });
}

// ── Rules view ──

const PREFIX_RE = /^(?:\*|[a-zA-Z0-9._-]+)$/;

function validateRulePrefix(prefix) {
  if (!prefix) return '请填写收件前缀';
  if (!PREFIX_RE.test(prefix)) return '前缀只能是 *，或包含字母、数字、点、下划线和连字符';
  return null;
}

function validateSelectedId(value, message) {
  return value && /^\d+$/.test(value) ? null : message;
}

let telegramBots = [];
let emailDestinations = [];
let barkEndpoints = [];

function emailDestinationOptions(selectedId = '') {
  const selected = String(selectedId ?? '');
  if (!emailDestinations.length) return '<option value="">请先添加邮件目标</option>';
  return `<option value="">请选择邮件目标</option>${emailDestinations.map((item) => `
    <option value="${item.id}" ${String(item.id) === selected ? 'selected' : ''}>${escapeHtml(item.name)} · ${escapeHtml(item.email_address)}</option>
  `).join('')}`;
}

function barkEndpointOptions(selectedId = '') {
  const selected = String(selectedId ?? '');
  if (!barkEndpoints.length) return '<option value="">请先添加 Bark 目标</option>';
  return `<option value="">请选择 Bark 目标</option>${barkEndpoints.map((item) => `
    <option value="${item.id}" ${String(item.id) === selected ? 'selected' : ''}>${escapeHtml(item.name)} · ••••${escapeHtml(item.key_hint)}</option>
  `).join('')}`;
}

// Which catalog stands behind each rule-form select. rulesView's setChannel
// needs the same answer when it activates a channel, so the mapping lives here
// rather than being spelled out again per control id.
function ruleCatalogEmpty(controlId) {
  if (controlId === 'rule-target') return !emailDestinations.length;
  if (controlId === 'rule-bark') return !barkEndpoints.length;
  if (controlId === 'rule-bot') return !telegramBots.length;
  return false;
}

function syncRuleSelect(controlId, buildOptions) {
  const select = $(`#${controlId}`);
  if (!select) return;
  const previous = select.value;
  select.innerHTML = buildOptions(previous);
  select.disabled = select.closest('[data-channel-fields]')?.hidden || ruleCatalogEmpty(controlId);
}

// Each loader syncs only the selects it owns: a bot refresh must not reset a
// half-filled forward rule.
function syncDestinationSelects() {
  syncRuleSelect('rule-target', emailDestinationOptions);
  syncRuleSelect('rule-bark', barkEndpointOptions);
}

async function loadDestinationCatalogs() {
  const [emailResult, barkResult] = await Promise.all([
    api('/destinations/emails'),
    api('/destinations/bark'),
  ]);
  emailDestinations = emailResult.data || [];
  barkEndpoints = barkResult.data || [];
  syncDestinationSelects();
}

function telegramBotOptionLabel(bot) {
  const username = bot.username ? ` · @${bot.username}` : '';
  return `${bot.name}${username}`;
}

function telegramBotOptions(selectedId = '') {
  const selected = String(selectedId ?? '');
  if (!telegramBots.length) {
    return '<option value="">请先添加 Bot</option>';
  }
  return `<option value="">请选择 Bot</option>${telegramBots.map((bot) => `
    <option value="${bot.id}" ${String(bot.id) === selected ? 'selected' : ''}>${escapeHtml(telegramBotOptionLabel(bot))}</option>
  `).join('')}`;
}

function syncTelegramBotSelect() {
  syncRuleSelect('rule-bot', telegramBotOptions);
}

async function loadTelegramBotCatalog() {
  const result = await api('/settings/telegram-bots');
  telegramBots = result.data || [];
  syncTelegramBotSelect();
  return result;
}

function telegramErrorMessage(error) {
  const detail = error.details?.telegram?.description;
  return detail ? `${error.message}：${detail}` : error.message;
}

function openTelegramBotCreateModal({ onCreated } = {}) {
  const overlay = openModal(`
    <form class="create-telegram-bot-form" novalidate>
      <div class="modal-header">
        <div>
          <h3 class="modal-title">添加 Telegram Bot</h3>
          <p class="modal-subtitle">保存前会向 Telegram 验证 Token，完整 Token 不会在页面中回显。</p>
        </div>
        <button type="button" class="icon-btn" data-act="close" title="关闭" aria-label="关闭">${ICONS.close}</button>
      </div>
      <div class="modal-body edit-rule-fields">
        <div class="field">
          <label class="field-label" for="create-bot-name">名称</label>
          <input id="create-bot-name" name="name" type="text" maxlength="50" placeholder="例如：验证码通知" autocomplete="off" spellcheck="false" required>
        </div>
        <div class="field">
          <label class="field-label" for="create-bot-token">Bot Token</label>
          <input id="create-bot-token" name="token" type="password" placeholder="123456789:AA..." autocomplete="new-password" spellcheck="false" required>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn" data-act="close">取消</button>
        <button type="submit" class="btn btn-primary">验证、添加并选中</button>
      </div>
    </form>
  `, { small: true });

  overlay.querySelectorAll('[data-act="close"]').forEach((button) => {
    button.addEventListener('click', closeModal);
  });

  const form = overlay.querySelector('.create-telegram-bot-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = form.elements.name.value.trim();
    const token = form.elements.token.value.trim();
    if (!name || !token) {
      toast('请填写 Bot 名称和 Token', 'error');
      return;
    }

    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.innerHTML = '<span class="spinner" aria-hidden="true"></span>验证中…';
    try {
      const created = await api('/settings/telegram-bots', {
        method: 'POST',
        body: JSON.stringify({ name, token }),
      });
      closeModal();
      toast('Bot 已验证并添加', 'success');
      if (onCreated) {
        try {
          await onCreated(created);
        } catch (error) {
          if (error.status !== 401) toast(`Bot 列表刷新失败：${error.message}`, 'error');
        }
      }
    } catch (error) {
      if (error.status !== 401) toast(`添加失败：${telegramErrorMessage(error)}`, 'error');
    } finally {
      button.disabled = false;
      button.textContent = '验证、添加并选中';
    }
  });

  overlay.querySelector('#create-bot-name').focus();
}

function openEmailDestinationCreateModal({ onCreated } = {}) {
  const overlay = openModal(`
    <form class="create-email-destination-form" novalidate>
      <div class="modal-header">
        <div>
          <h3 class="modal-title">添加邮件目标</h3>
          <p class="modal-subtitle">完成 Email Sending 配置后，可发送到任意有效邮箱，无需逐个验证。</p>
        </div>
        <button type="button" class="icon-btn" data-act="close" title="关闭" aria-label="关闭">${ICONS.close}</button>
      </div>
      <div class="modal-body edit-rule-fields">
        <div class="field">
          <label class="field-label" for="create-email-target-name">名称</label>
          <input id="create-email-target-name" name="name" type="text" maxlength="50" placeholder="例如：个人邮箱" required>
        </div>
        <div class="field">
          <label class="field-label" for="create-email-target-address">邮箱地址</label>
          <input id="create-email-target-address" name="email_address" type="email" placeholder="me@example.com" autocomplete="email" required>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn" data-act="close">取消</button>
        <button type="submit" class="btn btn-primary">添加并选中</button>
      </div>
    </form>
  `, { small: true });

  overlay.querySelectorAll('[data-act="close"]').forEach((button) => button.addEventListener('click', closeModal));
  const form = overlay.querySelector('.create-email-destination-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      name: form.elements.name.value.trim(),
      email_address: form.elements.email_address.value.trim(),
    };
    if (!payload.name || !payload.email_address) {
      toast('请填写目标名称和邮箱地址', 'error');
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.innerHTML = '<span class="spinner" aria-hidden="true"></span>添加中…';
    try {
      const created = await api('/destinations/emails', { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      toast('邮件目标已添加', 'success');
      if (onCreated) {
        try {
          await onCreated(created);
        } catch (error) {
          if (error.status !== 401) toast(`目标列表刷新失败：${error.message}`, 'error');
        }
      }
    } catch (error) {
      if (error.status !== 401) toast(`添加失败：${error.message}`, 'error');
    } finally {
      button.disabled = false;
      button.textContent = '添加并选中';
    }
  });
  overlay.querySelector('#create-email-target-name').focus();
}

function openBarkDestinationCreateModal({ onCreated } = {}) {
  const overlay = openModal(`
    <form class="create-bark-destination-form" novalidate>
      <div class="modal-header">
        <div>
          <h3 class="modal-title">添加 Bark 目标</h3>
          <p class="modal-subtitle">官方服务保留默认地址；自建服务填写公开 HTTPS 根地址。</p>
        </div>
        <button type="button" class="icon-btn" data-act="close" title="关闭" aria-label="关闭">${ICONS.close}</button>
      </div>
      <div class="modal-body edit-rule-fields">
        <div class="field">
          <label class="field-label" for="create-bark-target-name">名称</label>
          <input id="create-bark-target-name" name="name" type="text" maxlength="50" placeholder="例如：我的 iPhone" required>
        </div>
        <div class="field">
          <label class="field-label" for="create-bark-device-key">Device Key</label>
          <input id="create-bark-device-key" name="device_key" type="password" placeholder="Bark App 中显示的设备 Key" autocomplete="new-password" required>
        </div>
        <div class="field">
          <label class="field-label" for="create-bark-server-url">Bark Server 地址</label>
          <input id="create-bark-server-url" name="server_url" type="url" value="https://api.day.app" inputmode="url" spellcheck="false" required>
          <small class="field-help">系统会调用该地址的 <code>/push</code> 接口。</small>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn" data-act="close">取消</button>
        <button type="submit" class="btn btn-primary">添加并选中</button>
      </div>
    </form>
  `, { small: true });

  overlay.querySelectorAll('[data-act="close"]').forEach((button) => button.addEventListener('click', closeModal));
  const form = overlay.querySelector('.create-bark-destination-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      name: form.elements.name.value.trim(),
      device_key: form.elements.device_key.value.trim(),
      server_url: form.elements.server_url.value.trim(),
    };
    if (!payload.name || !payload.device_key || !payload.server_url) {
      toast('请填写名称、Device Key 和 Server 地址', 'error');
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.innerHTML = '<span class="spinner" aria-hidden="true"></span>添加中…';
    try {
      const created = await api('/destinations/bark', { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      toast('Bark 目标已添加，可稍后在推送目标页测试', 'success');
      if (onCreated) {
        try {
          await onCreated(created);
        } catch (error) {
          if (error.status !== 401) toast(`目标列表刷新失败：${error.message}`, 'error');
        }
      }
    } catch (error) {
      if (error.status !== 401) toast(`添加失败：${error.message}`, 'error');
    } finally {
      button.disabled = false;
      button.textContent = '添加并选中';
    }
  });
  overlay.querySelector('#create-bark-target-name').focus();
}

const CHANNELS = {
  forward: {
    endpoint: '/rules/forward',
    label: '转发',
    editTitle: '编辑邮件转发规则',
    toggleLabel: '启用邮件转发规则',
    valueField: 'destination_id',
    valueLabel: '邮件目标',
    targetOf: (rule) => rule.target_email,
    validate: ({ prefix, destination_id }) => {
      return validateRulePrefix(prefix) || validateSelectedId(destination_id, '请选择邮件目标');
    },
  },
  tg: {
    endpoint: '/rules/tg',
    label: 'Telegram',
    editTitle: '编辑 Telegram 推送规则',
    toggleLabel: '启用 Telegram 推送规则',
    valueField: 'chat_id',
    valueLabel: 'Chat ID',
    inputType: 'text',
    targetOf: (rule) => rule.chat_id,
    validate: ({ prefix, chat_id, bot_id }) => {
      const prefixError = validateRulePrefix(prefix);
      if (prefixError) return prefixError;
      if (!chat_id || !/^-?\d+$/.test(chat_id)) return 'Chat ID 应为纯数字（群组为负数）';
      return validateSelectedId(bot_id, '请选择 Telegram Bot');
    },
  },
  bark: {
    endpoint: '/rules/bark',
    label: 'Bark',
    editTitle: '编辑 Bark 推送规则',
    toggleLabel: '启用 Bark 推送规则',
    valueField: 'endpoint_id',
    valueLabel: 'Bark 目标',
    targetOf: (rule) => rule.endpoint_name,
    validate: ({ prefix, endpoint_id }) => {
      return validateRulePrefix(prefix) || validateSelectedId(endpoint_id, '请选择 Bark 目标');
    },
  },
};

// ── Boot ──

migrateLegacyStorage();
initTheme();
initAuth();
emailsView.init();
rulesView.init();
logsView.init();
settingsView.init();
initDestinationTabs();
initTabs();

if (getToken()) {
  showApp();
} else {
  showLogin();
}

// Consumed by the view modules. Every reference to these lives inside a function
// body, so the import cycle is resolved before any of them is evaluated.
export { $, CHANNELS, ICONS, activeTab, api, barkEndpointOptions, barkEndpoints, closeModal, confirmDialog, copyText };
export { debounce, emailDestinationOptions, emailDestinations, emptyStateHtml, errorStateHtml, escapeHtml };
export { extractCode, fullTime, loadDestinationCatalogs, loadTelegramBotCatalog, loadedTabs };
export { openBarkDestinationCreateModal, openEmailDestinationCreateModal, openModal, openTelegramBotCreateModal };
export { parseDate, relTime, renderSkeleton, ruleCatalogEmpty, showState, showTable, telegramBotOptions, telegramBots };
export { toast };
