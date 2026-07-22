import { buildEmailPreviewDocument } from './email-preview.js';
import { migrateLegacyStorage, THEME_KEY, TOKEN_KEY } from './storage.js';

// ═══════════════════════════════════════════════
// MailCast — console app
// ═══════════════════════════════════════════════

const $ = (sel, root = document) => root.querySelector(sel);

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
    const token = input.value.trim();
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
      if (res.ok) {
        const session = await res.json();
        sessionToken = session.token || '';
        ok = Boolean(sessionToken);
      }
      else if (res.status === 401) errMsg = '令牌无效，请检查后重试';
      else if (res.status === 503) errMsg = '管理密码尚未初始化，请先完成部署配置';
      else errMsg = `服务异常（HTTP ${res.status}）`;
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
    } else {
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

// ── Emails view ──

const emailsView = (() => {
  let page = 1;
  let prefix = '';
  let seq = 0;
  const byId = new Map();
  const LIMIT = 20;

  const tbody = () => $('#emails-body');
  const stateEl = () => $('#emails-state');
  const tableEl = () => $('#emails-table');

  async function load() {
    const my = ++seq;
    $('#emails-pagination').hidden = true;
    showTable(stateEl(), tableEl());
    renderSkeleton(tbody(), ['70%', '48px', '85%', '72px', '20px']);

    let res;
    try {
      let url = `/emails?page=${page}&limit=${LIMIT}`;
      if (prefix) url += `&prefix=${encodeURIComponent(prefix)}`;
      res = await api(url);
    } catch (err) {
      if (my !== seq || err.status === 401) return;
      tbody().innerHTML = '';
      showState(stateEl(), tableEl(), errorStateHtml(err.message));
      return;
    }
    if (my !== seq) return;
    render(res);
  }

  function render({ data, total, page: cur, limit }) {
    byId.clear();
    $('#email-count').textContent = total > 0 ? `共 ${total} 封` : '';

    if (!data || data.length === 0) {
      tbody().innerHTML = '';
      $('#emails-pagination').hidden = true;
      showState(stateEl(), tableEl(), emptyStateHtml(
        ICONS.inbox,
        prefix ? `没有前缀为 “${prefix}” 的邮件` : '暂无邮件',
        prefix ? '试试其他前缀，或清空筛选条件' : '收到的邮件会自动出现在这里',
      ));
      return;
    }

    showTable(stateEl(), tableEl());
    for (const e of data) byId.set(String(e.id), e);

    tbody().innerHTML = data.map((e) => {
      const code = extractCode(e);
      const codeChip = code
        ? `<button class="code-chip" data-copy-code="${escapeHtml(code)}" title="点击复制验证码">${ICONS.key}${escapeHtml(code)}</button>`
        : '';
      return `
        <tr class="clickable" data-id="${e.id}" tabindex="0">
          <td class="cell-from" data-label="发件人" title="${escapeHtml(e.from_addr)}"><span class="mono">${escapeHtml(e.from_addr)}</span></td>
          <td data-label="前缀"><span class="chip">${escapeHtml(e.to_prefix)}</span></td>
          <td class="cell-subject" data-label="主题" title="${escapeHtml(e.subject)}"><span class="subject-text">${escapeHtml(e.subject || '（无主题）')}</span>${codeChip}</td>
          <td class="cell-time" data-label="时间"><time title="${escapeHtml(fullTime(e.created_at))}">${escapeHtml(relTime(e.created_at))}</time></td>
          <td class="cell-actions"><button class="icon-btn danger" data-del="${e.id}" title="删除" aria-label="删除">${ICONS.trash}</button></td>
        </tr>`;
    }).join('');

    const totalPages = Math.max(1, Math.ceil(total / limit));
    $('#emails-pagination').hidden = totalPages <= 1;
    $('#page-info').textContent = `第 ${cur} / ${totalPages} 页 · 共 ${total} 封`;
    $('#page-prev').disabled = cur <= 1;
    $('#page-next').disabled = cur >= totalPages;
  }

  function renderDetail(overlay, email) {
    const code = extractCode(email);
    const hasHtml = Boolean(email.html_body);
    const hasRaw = Boolean(email.raw_body);
    const preview = hasHtml ? buildEmailPreviewDocument(email.html_body) : null;
    let activeFormat = hasHtml ? 'html' : 'text';
    const formatSwitch = `
      <div class="body-format-switch" role="tablist" aria-label="正文格式">
        ${hasHtml ? '<button class="format-tab active" data-format="html" role="tab" aria-selected="true">HTML</button>' : ''}
        <button class="format-tab ${hasHtml ? '' : 'active'}" data-format="text" role="tab" aria-selected="${hasHtml ? 'false' : 'true'}">纯文本</button>
        <button class="format-tab" data-format="raw" role="tab" aria-selected="false">Raw</button>
      </div>`;

    overlay.querySelector('.modal').innerHTML = `
      <div class="modal-header">
        <div class="modal-heading">
          <span class="modal-kicker">邮件工作流</span>
          <h3 class="modal-title">${escapeHtml(email.subject || '（无主题）')}</h3>
        </div>
        <button class="icon-btn" data-act="close" title="关闭" aria-label="关闭">${ICONS.close}</button>
      </div>
      <div class="modal-body email-detail-body">
        <div class="workflow-canvas">
          <section class="workflow-source" aria-labelledby="source-node-title">
            <div class="workflow-column-heading">
              <span>输入</span>
              <strong id="source-node-title">原始邮件</strong>
            </div>
            <article class="workflow-node source-node">
              <div class="workflow-node-header">
                <span class="workflow-node-icon source-icon">${ICONS.inbox}</span>
                <div class="workflow-node-name">
                  <span>Incoming email</span>
                  <strong>${escapeHtml(email.subject || '（无主题）')}</strong>
                </div>
                <span class="source-state"><i></i>已接收</span>
              </div>
              <dl class="detail-meta">
                <dt>发件人</dt><dd>${escapeHtml(email.from_addr)}</dd>
                <dt>收件人</dt><dd>${escapeHtml(email.to_addr)}</dd>
                <dt>时间</dt><dd>${escapeHtml(fullTime(email.created_at))}</dd>
              </dl>
              ${code ? `
              <div class="code-banner">
                <span>检测到验证码</span>
                <span class="code-value">${escapeHtml(code)}</span>
                <button class="btn btn-sm" data-act="copy-code">${ICONS.copy} 复制</button>
              </div>` : ''}
              ${email.body_truncated ? `
              <div class="body-warning" role="status">
                ${ICONS.alert}<span>正文超过存储上限，以下内容已截断。</span>
              </div>` : ''}
              <div class="email-body-heading">
                <span class="email-body-label">邮件正文</span>
                ${formatSwitch}
              </div>
              ${hasHtml ? `
              <div data-format-panel="html">
                ${preview.hasExternalContent ? `
                <div class="remote-content-banner" data-remote-banner>
                  <span>已阻止外部图片与样式，避免触发邮件追踪。</span>
                  <button class="btn btn-sm" data-act="load-remote">加载外部内容</button>
                </div>` : ''}
                <iframe
                  class="email-preview-frame"
                  data-email-preview
                  title="HTML 邮件正文"
                  sandbox="allow-popups allow-popups-to-escape-sandbox"
                  referrerpolicy="no-referrer"
                ></iframe>
              </div>` : ''}
              <div class="detail-body email-plain-body" data-format-panel="text" ${hasHtml ? 'hidden' : ''}>
                ${escapeHtml(email.text_body || preview?.plainText || '（正文为空）')}
              </div>
              <div class="email-raw-panel" data-format-panel="raw" hidden>
                ${email.raw_truncated ? `
                <div class="body-warning" role="status">
                  ${ICONS.alert}<span>Raw 源码超过 256 KiB，以下内容已截断。</span>
                </div>` : ''}
                ${hasRaw
                  ? `<pre class="email-raw-body">${escapeHtml(email.raw_body)}</pre>`
                  : `<div class="raw-unavailable">${ICONS.alert}<span>此历史邮件未保存原始源码；新收到的邮件会自动保留 Raw。</span></div>`}
              </div>
              <span class="workflow-port output-port" aria-hidden="true"></span>
            </article>
          </section>

          <div class="workflow-bridge" aria-hidden="true"></div>

          <aside class="workflow-destinations" aria-labelledby="downstream-title">
            <div class="workflow-column-heading downstream-heading">
              <div>
                <span>输出</span>
                <strong id="downstream-title">触发的下游</strong>
              </div>
              <span class="downstream-refresh-label" data-downstream-updated>实时刷新</span>
            </div>
            <div class="downstream-list" data-downstream-list aria-live="polite">
              <div class="downstream-loading"><span class="spinner" aria-hidden="true"></span>正在读取下游状态…</div>
            </div>
            <form class="quick-downstream-panel workflow-add-node" data-forward-form novalidate>
              <button type="button" class="workflow-add-trigger" data-act="forward">
                <span class="workflow-node-icon add-icon">${ICONS.plus}</span>
                <span><strong>新建邮件转发</strong><small>添加一个新的下游节点</small></span>
              </button>
              <div class="quick-downstream-editor" data-forward-editor hidden>
                <div class="quick-downstream-heading">
                  <div>
                    <strong>邮件转发</strong>
                    <span>使用已保存的正文，不包含原邮件附件。</span>
                  </div>
                  <button type="button" class="icon-btn" data-act="cancel-forward" title="取消" aria-label="取消新建转发">${ICONS.close}</button>
                </div>
                <div class="quick-downstream-row">
                  <input name="to" type="email" maxlength="254" placeholder="recipient@example.com" autocomplete="email" required aria-label="转发收件邮箱">
                  <button type="submit" class="btn btn-primary">
                    <span class="spinner hidden" aria-hidden="true"></span>
                    <span data-forward-label>发送</span>
                  </button>
                </div>
                <div class="downstream-create-error" data-forward-error role="alert" hidden></div>
              </div>
              <span class="workflow-port input-port" aria-hidden="true"></span>
            </form>
            <form class="quick-downstream-panel quick-telegram-panel workflow-add-node" data-telegram-form novalidate>
              <button type="button" class="workflow-add-trigger" data-act="telegram">
                <span class="workflow-node-icon add-icon telegram-add-icon">${ICONS.send}</span>
                <span><strong>新建 Telegram 推送</strong><small>选择 Bot 并推送到指定会话</small></span>
              </button>
              <div class="quick-downstream-editor" data-telegram-editor hidden>
                <div class="quick-downstream-heading">
                  <div>
                    <strong>Telegram 推送</strong>
                    <span>行为与自动推送一致，包含验证码识别结果。</span>
                  </div>
                  <button type="button" class="icon-btn" data-act="cancel-telegram" title="取消" aria-label="取消新建 Telegram 推送">${ICONS.close}</button>
                </div>
                <div class="quick-telegram-fields">
                  <label class="field">
                    <span class="field-label">发送 Bot</span>
                    <select name="bot_id" required aria-label="发送 Bot">
                      ${telegramBotOptions()}
                    </select>
                  </label>
                  <label class="field">
                    <span class="field-label">Chat ID</span>
                    <input name="chat_id" type="text" placeholder="-1001234567890" autocomplete="off" spellcheck="false" required aria-label="Telegram Chat ID">
                  </label>
                  <button type="submit" class="btn btn-primary">
                    <span class="spinner hidden" aria-hidden="true"></span>
                    <span data-telegram-label>推送</span>
                  </button>
                </div>
                <div class="downstream-create-error" data-telegram-error role="alert" hidden></div>
              </div>
              <span class="workflow-port input-port" aria-hidden="true"></span>
            </form>
            <form class="quick-downstream-panel quick-bark-panel workflow-add-node" data-bark-form novalidate>
              <button type="button" class="workflow-add-trigger" data-act="bark">
                <span class="workflow-node-icon add-icon bark-add-icon">B</span>
                <span><strong>新建 Bark 推送</strong><small>推送到已保存的 Bark 设备</small></span>
              </button>
              <div class="quick-downstream-editor" data-bark-editor hidden>
                <div class="quick-downstream-heading">
                  <div><strong>Bark 推送</strong><span>包含邮件摘要与验证码识别结果。</span></div>
                  <button type="button" class="icon-btn" data-act="cancel-bark">${ICONS.close}</button>
                </div>
                <div class="quick-telegram-fields quick-bark-fields">
                  <label class="field"><span class="field-label">Bark 目标</span><select name="endpoint_id" required>${barkEndpointOptions()}</select></label>
                  <button type="submit" class="btn btn-primary"><span class="spinner hidden"></span><span data-bark-label>推送</span></button>
                </div>
                <div class="downstream-create-error" data-bark-error role="alert" hidden></div>
              </div>
              <span class="workflow-port input-port" aria-hidden="true"></span>
            </form>
            <p class="downstream-note">手动下游会保存执行状态；之后可在对应节点中再次触发。</p>
          </aside>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" data-act="copy-body"><span data-copy-label>复制正文</span></button>
        <button class="btn btn-danger" data-act="delete">删除邮件</button>
      </div>
    `;

    overlay.querySelector('[data-act="close"]').addEventListener('click', closeModal);
    const copyBodyButton = overlay.querySelector('[data-act="copy-body"]');
    copyBodyButton.addEventListener('click', () => {
      if (activeFormat === 'raw') {
        copyText(email.raw_body || '', 'Raw');
        return;
      }
      copyText(email.text_body || preview?.plainText || '', '正文');
    });
    const copyCodeBtn = overlay.querySelector('[data-act="copy-code"]');
    if (copyCodeBtn) copyCodeBtn.addEventListener('click', () => copyText(code, '验证码'));

    const previewFrame = overlay.querySelector('[data-email-preview]');
    if (previewFrame && preview) previewFrame.srcdoc = preview.srcdoc;

    overlay.querySelectorAll('[data-format]').forEach((button) => {
      button.addEventListener('click', () => {
        const format = button.dataset.format;
        activeFormat = format;
        overlay.querySelectorAll('[data-format]').forEach((tab) => {
          const active = tab.dataset.format === format;
          tab.classList.toggle('active', active);
          tab.setAttribute('aria-selected', String(active));
        });
        overlay.querySelectorAll('[data-format-panel]').forEach((panel) => {
          panel.hidden = panel.dataset.formatPanel !== format;
        });
        overlay.querySelector('[data-copy-label]').textContent = format === 'raw' ? '复制 Raw' : '复制正文';
        copyBodyButton.disabled = format === 'raw' && !hasRaw;
      });
    });

    const loadRemoteBtn = overlay.querySelector('[data-act="load-remote"]');
    if (loadRemoteBtn && previewFrame) {
      loadRemoteBtn.addEventListener('click', () => {
        const remotePreview = buildEmailPreviewDocument(email.html_body, { allowRemote: true });
        previewFrame.srcdoc = remotePreview.srcdoc;
        overlay.querySelector('[data-remote-banner]').remove();
      });
    }

    const downstreamList = overlay.querySelector('[data-downstream-list]');
    const downstreamUpdated = overlay.querySelector('[data-downstream-updated]');
    let downstreamSeq = 0;
    let downstreamLoading = false;
    let downstreamState = { tracked: false, data: [] };
    let confirmingDownstreamId = null;
    let downstreamFingerprint = '';

    function renderDownstreams(result) {
      downstreamState = result;
      downstreamFingerprint = JSON.stringify(result);
      const legacyHint = result.tracked ? '' : `
        <div class="downstream-legacy">这封邮件没有完整的自动下游记录：可能接收于功能上线前，或记录阶段发生过异常。</div>`;

      if (!result.data.length) {
        downstreamList.innerHTML = `${legacyHint}
          <div class="downstream-empty">
            ${result.tracked ? '这封邮件没有命中任何启用的下游规则。' : '暂无可展示或再次触发的下游。'}
          </div>`;
        return;
      }

      downstreamList.innerHTML = legacyHint + result.data.map((item) => {
        const stale = item.status === 'pending' && item.is_stale;
        const visibleStatus = stale ? 'stale' : item.status;
        const statusLabel = {
          pending: '执行中',
          success: '成功',
          failed: '失败',
          stale: '执行中断',
        }[visibleStatus];
        const channelLabel = item.channel === 'telegram' ? 'Telegram' : item.channel === 'bark' ? 'Bark' : '邮件转发';
        const sourceLabel = item.source === 'quick_forward'
          ? (item.channel === 'forward' ? '快速转发' : '手动触发')
          : '自动规则';
        const botLabel = item.channel === 'telegram' && item.telegram_bot_name
          ? ` · ${item.telegram_bot_name}`
          : '';
        const isConfirming = confirmingDownstreamId === String(item.id);
        const retryAction = isConfirming ? `
          <div class="downstream-confirm" role="group" aria-label="确认再次触发">
            <span>确定再次触发？</span>
            <button class="btn btn-sm" data-cancel-retry="${item.id}">取消</button>
            <button class="btn btn-primary btn-sm" data-confirm-retry="${item.id}">确认</button>
          </div>` : `
          <button class="btn btn-sm" data-retry-downstream="${item.id}"
            ${item.status === 'pending' && !stale ? 'disabled' : ''}>${ICONS.forward} 再次触发</button>`;

        const channelIcon = item.channel === 'bark' ? 'B' : item.channel === 'telegram' ? ICONS.send : ICONS.forward;
        return `
          <article class="workflow-node downstream-item node-${visibleStatus}" data-downstream-id="${item.id}">
            <div class="workflow-node-header downstream-main">
              <span class="workflow-node-icon channel-${item.channel}">${channelIcon}</span>
              <div class="workflow-node-name">
                <span>${escapeHtml(channelLabel)}${escapeHtml(botLabel)} · ${escapeHtml(sourceLabel)}</span>
                <strong class="downstream-target mono">${escapeHtml(item.target)}</strong>
              </div>
              <span class="downstream-status status-${visibleStatus}"><i></i>${escapeHtml(statusLabel)}</span>
            </div>
            <div class="downstream-meta">
              <span>已尝试 ${item.attempt_count} 次</span>
              <time title="${escapeHtml(fullTime(item.last_triggered_at))}">${escapeHtml(relTime(item.last_triggered_at))}</time>
            </div>
            ${item.last_error ? `<div class="downstream-error">${escapeHtml(item.last_error)}</div>` : ''}
            <div class="downstream-action">${retryAction}</div>
            <span class="workflow-port input-port" aria-hidden="true"></span>
          </article>`;
      }).join('');
    }

    async function loadDownstreams({ quiet = false } = {}) {
      if (downstreamLoading || !overlay.isConnected) return;
      downstreamLoading = true;
      const my = ++downstreamSeq;
      if (!quiet && !downstreamState.data.length) {
        downstreamList.innerHTML = '<div class="downstream-loading"><span class="spinner" aria-hidden="true"></span>正在读取下游状态…</div>';
      }
      try {
        const result = await api(`/emails/${email.id}/downstreams`);
        if (my !== downstreamSeq || !overlay.isConnected) return;
        // Keep the card DOM stable while nothing changed. Besides avoiding
        // needless work, this prevents polling from racing a user's click on
        // the inline retry confirmation controls.
        const nextFingerprint = JSON.stringify(result);
        if (nextFingerprint !== downstreamFingerprint) renderDownstreams(result);
        downstreamUpdated.textContent = `自动刷新 · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      } catch (error) {
        if (my !== downstreamSeq || !overlay.isConnected || error.status === 401) return;
        if (!quiet || !downstreamState.data.length) {
          downstreamList.innerHTML = `<div class="downstream-load-error">状态加载失败：${escapeHtml(error.message)}</div>`;
        }
      } finally {
        downstreamLoading = false;
      }
    }

    downstreamList.addEventListener('click', async (event) => {
      const retryButton = event.target.closest('[data-retry-downstream]');
      if (retryButton) {
        confirmingDownstreamId = retryButton.dataset.retryDownstream;
        renderDownstreams(downstreamState);
        return;
      }

      const cancelButton = event.target.closest('[data-cancel-retry]');
      if (cancelButton) {
        confirmingDownstreamId = null;
        renderDownstreams(downstreamState);
        return;
      }

      const confirmButton = event.target.closest('[data-confirm-retry]');
      if (!confirmButton || confirmButton.disabled) return;
      const id = confirmButton.dataset.confirmRetry;
      const target = downstreamState.data.find((item) => String(item.id) === id);
      if (!target) return;

      confirmButton.disabled = true;
      confirmButton.innerHTML = '<span class="spinner" aria-hidden="true"></span>触发中…';
      try {
        await api(`/emails/${email.id}/downstreams/${id}/retry`, { method: 'POST' });
        confirmingDownstreamId = null;
        const retriedLabel = target.channel === 'telegram' ? 'Telegram 推送' : target.channel === 'bark' ? 'Bark 推送' : '邮件转发';
        toast(`${retriedLabel}已再次触发`, 'success');
      } catch (error) {
        confirmingDownstreamId = null;
        if (error.status !== 401) {
          const description = error.details?.downstream?.description || error.message;
          toast(`再次触发失败：${description}`, 'error');
        }
      } finally {
        await loadDownstreams({ quiet: true });
      }
    });

    void loadDownstreams();
    const downstreamTimer = setInterval(() => void loadDownstreams({ quiet: true }), 3000);
    overlay.addEventListener('modal-closed', () => clearInterval(downstreamTimer), { once: true });

    const forwardForm = overlay.querySelector('[data-forward-form]');
    const forwardEditor = forwardForm.querySelector('[data-forward-editor]');
    const forwardTrigger = forwardForm.querySelector('[data-act="forward"]');
    const forwardInput = forwardForm.querySelector('input[name="to"]');
    const forwardError = overlay.querySelector('[data-forward-error]');
    const telegramForm = overlay.querySelector('[data-telegram-form]');
    const telegramEditor = telegramForm.querySelector('[data-telegram-editor]');
    const telegramTrigger = telegramForm.querySelector('[data-act="telegram"]');
    const telegramSelect = telegramForm.querySelector('select[name="bot_id"]');
    const telegramChatInput = telegramForm.querySelector('input[name="chat_id"]');
    const telegramError = telegramForm.querySelector('[data-telegram-error]');
    const barkForm = overlay.querySelector('[data-bark-form]');
    const barkEditor = barkForm.querySelector('[data-bark-editor]');
    const barkTrigger = barkForm.querySelector('[data-act="bark"]');
    const barkSelect = barkForm.querySelector('select[name="endpoint_id"]');
    const barkError = barkForm.querySelector('[data-bark-error]');

    function closeForwardEditor() {
      forwardEditor.hidden = true;
      forwardTrigger.hidden = false;
      forwardForm.classList.remove('is-editing');
      forwardError.hidden = true;
    }

    function closeTelegramEditor() {
      telegramEditor.hidden = true;
      telegramTrigger.hidden = false;
      telegramForm.classList.remove('is-editing');
      telegramError.hidden = true;
    }

    function closeBarkEditor() {
      barkEditor.hidden = true;
      barkTrigger.hidden = false;
      barkForm.classList.remove('is-editing');
      barkError.hidden = true;
    }

    async function refreshQuickTelegramBots() {
      const previous = telegramSelect.value;
      try {
        await loadTelegramBotCatalog();
        telegramSelect.innerHTML = telegramBotOptions(previous);
        telegramSelect.disabled = telegramBots.length === 0;
        if (!telegramBots.length) {
          telegramError.innerHTML = '<strong>尚未配置 Telegram Bot</strong><span>请先到“推送目标”添加并验证 Bot。</span>';
          telegramError.hidden = false;
        }
      } catch (error) {
        telegramSelect.disabled = true;
        telegramError.innerHTML = `<strong>Bot 列表加载失败</strong><span>${escapeHtml(error.message)}</span>`;
        telegramError.hidden = false;
      }
    }

    forwardTrigger.addEventListener('click', () => {
      closeTelegramEditor();
      closeBarkEditor();
      forwardTrigger.hidden = true;
      forwardEditor.hidden = false;
      forwardForm.classList.add('is-editing');
      forwardError.hidden = true;
      forwardInput.focus();
      forwardForm.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    overlay.querySelector('[data-act="cancel-forward"]').addEventListener('click', () => {
      closeForwardEditor();
    });
    forwardForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const to = forwardInput.value.trim();
      if (!forwardInput.checkValidity()) {
        forwardInput.reportValidity();
        return;
      }

      const sendButton = forwardForm.querySelector('button[type="submit"]');
      const spinner = sendButton.querySelector('.spinner');
      const label = sendButton.querySelector('[data-forward-label]');
      sendButton.disabled = true;
      spinner.classList.remove('hidden');
      label.textContent = '发送中…';
      forwardError.hidden = true;

      try {
        await api(`/emails/${email.id}/forward`, {
          method: 'POST',
          body: JSON.stringify({ to }),
        });
        forwardForm.reset();
        closeForwardEditor();
        toast(`邮件已转发到 ${to}`, 'success');
      } catch (error) {
        if (error.status !== 401) {
          const details = error.details?.email;
          const codeLine = details?.code ? `<code>${escapeHtml(details.code)}</code>` : '';
          const description = details?.description || error.message;
          forwardError.innerHTML = `
            <strong>${escapeHtml(error.message)}</strong>
            ${codeLine}
            <span>${escapeHtml(description)}</span>
            <small>请确认收件地址已验证，且 liaoguoyin.com 已在 Cloudflare Email Sending 中完成 Onboard。</small>`;
          forwardError.hidden = false;
        }
      } finally {
        sendButton.disabled = false;
        spinner.classList.add('hidden');
        label.textContent = '发送';
        void loadDownstreams({ quiet: true });
      }
    });

    telegramTrigger.addEventListener('click', async () => {
      closeForwardEditor();
      closeBarkEditor();
      telegramTrigger.hidden = true;
      telegramEditor.hidden = false;
      telegramForm.classList.add('is-editing');
      telegramError.hidden = true;
      await refreshQuickTelegramBots();
      if (!telegramEditor.hidden) {
        if (!telegramSelect.disabled) telegramSelect.focus();
        telegramForm.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
    overlay.querySelector('[data-act="cancel-telegram"]').addEventListener('click', () => {
      closeTelegramEditor();
    });
    telegramForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const botId = telegramSelect.value;
      const chatId = telegramChatInput.value.trim();
      if (!botId) {
        telegramError.innerHTML = '<strong>请选择 Telegram Bot</strong><span>如果列表为空，请先到“推送目标”添加 Bot。</span>';
        telegramError.hidden = false;
        return;
      }
      if (!/^-?\d+$/.test(chatId)) {
        telegramError.innerHTML = '<strong>Chat ID 格式不正确</strong><span>个人会话为正数，群组或频道通常为负数。</span>';
        telegramError.hidden = false;
        telegramChatInput.focus();
        return;
      }

      const sendButton = telegramForm.querySelector('button[type="submit"]');
      const spinner = sendButton.querySelector('.spinner');
      const label = sendButton.querySelector('[data-telegram-label]');
      const selectedBot = telegramBots.find((bot) => String(bot.id) === botId);
      sendButton.disabled = true;
      spinner.classList.remove('hidden');
      label.textContent = '推送中…';
      telegramError.hidden = true;

      try {
        await api(`/emails/${email.id}/telegram`, {
          method: 'POST',
          body: JSON.stringify({ bot_id: botId, chat_id: chatId }),
        });
        telegramForm.reset();
        closeTelegramEditor();
        toast(`已通过 ${selectedBot?.name || 'Telegram Bot'} 推送到 ${chatId}`, 'success');
      } catch (error) {
        if (error.status !== 401) {
          const details = error.details?.downstream;
          const codeLine = details?.code ? `<code>${escapeHtml(details.code)}</code>` : '';
          const description = details?.description || error.message;
          telegramError.innerHTML = `
            <strong>${escapeHtml(error.message)}</strong>
            ${codeLine}
            <span>${escapeHtml(description)}</span>
            <small>请确认 Bot Token、Chat ID、会话状态以及机器人发送权限。</small>`;
          telegramError.hidden = false;
        }
      } finally {
        sendButton.disabled = false;
        spinner.classList.add('hidden');
        label.textContent = '推送';
        void loadDownstreams({ quiet: true });
      }
    });

    barkTrigger.addEventListener('click', async () => {
      closeForwardEditor();
      closeTelegramEditor();
      barkTrigger.hidden = true;
      barkEditor.hidden = false;
      barkForm.classList.add('is-editing');
      barkError.hidden = true;
      try {
        await loadDestinationCatalogs();
        barkSelect.innerHTML = barkEndpointOptions(barkSelect.value);
        barkSelect.disabled = !barkEndpoints.length;
        if (!barkEndpoints.length) {
          barkError.innerHTML = '<strong>尚未配置 Bark 目标</strong><span>请先到“推送目标”添加设备。</span>';
          barkError.hidden = false;
        } else barkSelect.focus();
      } catch (error) {
        barkError.innerHTML = `<strong>目标列表加载失败</strong><span>${escapeHtml(error.message)}</span>`;
        barkError.hidden = false;
      }
    });
    overlay.querySelector('[data-act="cancel-bark"]').addEventListener('click', closeBarkEditor);
    barkForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const endpointId = barkSelect.value;
      if (!endpointId) {
        barkError.innerHTML = '<strong>请选择 Bark 目标</strong><span>如果列表为空，请先到“推送目标”添加设备。</span>';
        barkError.hidden = false;
        return;
      }
      const button = barkForm.querySelector('button[type="submit"]');
      const spinner = button.querySelector('.spinner');
      const label = button.querySelector('[data-bark-label]');
      const endpoint = barkEndpoints.find((item) => String(item.id) === endpointId);
      button.disabled = true;
      spinner.classList.remove('hidden');
      label.textContent = '推送中…';
      try {
        await api(`/emails/${email.id}/bark`, {
          method: 'POST',
          body: JSON.stringify({ endpoint_id: endpointId }),
        });
        barkForm.reset();
        closeBarkEditor();
        toast(`已推送到 ${endpoint?.name || 'Bark'}`, 'success');
      } catch (error) {
        if (error.status !== 401) {
          const description = error.details?.downstream?.description || error.message;
          barkError.innerHTML = `<strong>${escapeHtml(error.message)}</strong><span>${escapeHtml(description)}</span>`;
          barkError.hidden = false;
        }
      } finally {
        button.disabled = false;
        spinner.classList.add('hidden');
        label.textContent = '推送';
        void loadDownstreams({ quiet: true });
      }
    });

    overlay.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      closeModal();
      await remove(email);
    });
  }

  function openDetail(summary) {
    const overlay = openModal(`
      <div class="modal-header">
        <h3 class="modal-title">${escapeHtml(summary.subject || '（无主题）')}</h3>
        <button class="icon-btn" data-act="close" title="关闭" aria-label="关闭">${ICONS.close}</button>
      </div>
      <div class="modal-body detail-loading" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <span>正在加载邮件正文…</span>
      </div>
    `, { wide: true });

    overlay.querySelector('[data-act="close"]').addEventListener('click', closeModal);

    async function loadDetail() {
      try {
        const email = await api(`/emails/${summary.id}`);
        if (overlay.isConnected) renderDetail(overlay, email);
      } catch (err) {
        if (!overlay.isConnected || err.status === 401) return;
        overlay.querySelector('.modal').innerHTML = `
          <div class="modal-header">
            <h3 class="modal-title">${escapeHtml(summary.subject || '（无主题）')}</h3>
            <button class="icon-btn" data-act="close" title="关闭" aria-label="关闭">${ICONS.close}</button>
          </div>
          <div class="modal-body detail-error">
            ${errorStateHtml(err.message)}
          </div>
        `;
        overlay.querySelector('[data-act="close"]').addEventListener('click', closeModal);
        overlay.querySelector('[data-retry]').addEventListener('click', () => {
          openDetail(summary);
        });
      }
    }

    void loadDetail();
  }

  async function remove(email) {
    const ok = await confirmDialog({
      title: '删除邮件',
      message: `确定删除来自 ${email.from_addr} 的邮件？此操作不可撤销。`,
    });
    if (!ok) return;
    try {
      await api(`/emails/${email.id}`, { method: 'DELETE' });
      toast('邮件已删除', 'success');
      load();
    } catch (err) {
      if (err.status !== 401) toast(`删除失败：${err.message}`, 'error');
    }
  }

  function init() {
    const doSearch = (value) => {
      const next = value.trim();
      if (next === prefix) return;
      prefix = next;
      page = 1;
      load();
    };
    const searchInput = $('#email-search');
    searchInput.addEventListener('input', debounce(() => doSearch(searchInput.value), 300));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSearch(searchInput.value);
    });

    $('#emails-refresh').addEventListener('click', async () => {
      const btn = $('#emails-refresh');
      btn.classList.add('spinning');
      await load();
      btn.classList.remove('spinning');
    });

    $('#page-prev').addEventListener('click', () => {
      if (page > 1) { page--; load(); }
    });
    $('#page-next').addEventListener('click', () => {
      page++;
      load();
    });

    stateEl().addEventListener('click', (e) => {
      if (e.target.closest('[data-retry]')) load();
    });

    tbody().addEventListener('click', (e) => {
      const codeBtn = e.target.closest('[data-copy-code]');
      if (codeBtn) {
        copyText(codeBtn.dataset.copyCode, '验证码');
        return;
      }
      const delBtn = e.target.closest('[data-del]');
      if (delBtn) {
        const email = byId.get(delBtn.dataset.del);
        if (email) remove(email);
        return;
      }
      const row = e.target.closest('tr[data-id]');
      if (row) {
        const email = byId.get(row.dataset.id);
        if (email) openDetail(email);
      }
    });
    tbody().addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const row = e.target.closest('tr[data-id]');
      if (row && e.target === row) {
        const email = byId.get(row.dataset.id);
        if (email) openDetail(email);
      }
    });
  }

  return { load, init };
})();

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

function syncDestinationSelects() {
  const emailSelect = $('#rule-target');
  if (emailSelect) {
    const previous = emailSelect.value;
    emailSelect.innerHTML = emailDestinationOptions(previous);
    emailSelect.disabled = emailSelect.closest('[data-channel-fields]')?.hidden || !emailDestinations.length;
  }
  const barkSelect = $('#rule-bark');
  if (barkSelect) {
    const previous = barkSelect.value;
    barkSelect.innerHTML = barkEndpointOptions(previous);
    barkSelect.disabled = barkSelect.closest('[data-channel-fields]')?.hidden || !barkEndpoints.length;
  }
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
  const select = $('#rule-bot');
  if (!select) return;
  const previous = select.value;
  select.innerHTML = telegramBotOptions(previous);
  select.disabled = select.closest('[data-channel-fields]')?.hidden || telegramBots.length === 0;
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
          <p class="modal-subtitle">目标邮箱仍需先在 Cloudflare Email Routing 中完成验证。</p>
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

const rulesView = (() => {
  let seq = 0;
  let mailDomain = '';
  const byId = new Map();

  const listEl = () => $('#rules-groups');
  const stateEl = () => $('#rules-state');

  function keyOf(rule) {
    return `${rule.channel}:${rule.id}`;
  }

  async function load() {
    const my = ++seq;
    showTable(stateEl(), listEl());
    listEl().innerHTML = Array.from({ length: 3 }, () => `
      <section class="rule-prefix-card rule-prefix-skeleton" aria-hidden="true">
        <div class="rule-prefix-header"><span class="skeleton" style="width:120px"></span><span class="skeleton" style="width:72px"></span></div>
        <div class="rule-group-row"><span class="skeleton" style="width:68px"></span><span class="skeleton" style="width:48%"></span><span class="skeleton" style="width:88px"></span></div>
      </section>`).join('');

    let rules;
    try {
      const [forwardRules, tgRules, barkRules, , , settings] = await Promise.all([
        api(CHANNELS.forward.endpoint),
        api(CHANNELS.tg.endpoint),
        api(CHANNELS.bark.endpoint),
        loadTelegramBotCatalog(),
        loadDestinationCatalogs(),
        api('/settings').catch((error) => {
          if (error.status === 401) throw error;
          return { mail_domain: '' };
        }),
      ]);
      mailDomain = settings.mail_domain || '';
      rules = [
        ...forwardRules.map((rule) => ({ ...rule, channel: 'forward' })),
        ...tgRules.map((rule) => ({ ...rule, channel: 'tg' })),
        ...barkRules.map((rule) => ({ ...rule, channel: 'bark' })),
      ];
    } catch (err) {
      if (my !== seq || err.status === 401) return;
      listEl().innerHTML = '';
      showState(stateEl(), listEl(), errorStateHtml(err.message));
      return;
    }
    if (my !== seq) return;
    render(rules);
  }

  function renderTarget(rule) {
    if (rule.channel === 'forward') {
      return `<span class="rule-target-stack"><strong>${escapeHtml(rule.destination_name)}</strong><span class="mono">${escapeHtml(rule.target_email)}</span></span>`;
    }
    if (rule.channel === 'bark') {
      return `<span class="rule-target-stack"><strong>${escapeHtml(rule.endpoint_name)}</strong><span class="mono">${escapeHtml(rule.server_url)}</span></span>`;
    }
    const label = rule.bot_name || '未绑定 Bot';
    const detail = rule.bot_username ? `@${rule.bot_username}` : '';
    return `<span class="rule-target-stack">
      <span class="mono">${escapeHtml(rule.chat_id)}</span>
      <span class="rule-bot ${rule.bot_name ? '' : 'is-missing'}">
        <i aria-hidden="true"></i><span>${escapeHtml(label)}</span>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}
      </span>
    </span>`;
  }

  function render(rules) {
    byId.clear();
    if (!rules.length) {
      listEl().innerHTML = '';
      showState(stateEl(), listEl(), emptyStateHtml(
        ICONS.inbox,
        '暂无路由规则',
        '添加规则后，匹配前缀的邮件将自动转发或推送',
      ));
      return;
    }

    showTable(stateEl(), listEl());
    for (const rule of rules) byId.set(keyOf(rule), rule);

    const channelRank = { tg: 0, bark: 1, forward: 2 };
    const grouped = new Map();
    for (const rule of rules) {
      if (!grouped.has(rule.prefix)) grouped.set(rule.prefix, []);
      grouped.get(rule.prefix).push(rule);
    }
    const groups = [...grouped.entries()].sort(([prefixA], [prefixB]) => {
      if (prefixA === '*') return 1;
      if (prefixB === '*') return -1;
      return prefixA.localeCompare(prefixB, 'en', { sensitivity: 'base' });
    });

    listEl().innerHTML = groups.map(([prefix, groupRules]) => {
      const wildcard = prefix === '*';
      const address = `${prefix}@${mailDomain || '…'}`;
      const sortedRules = [...groupRules].sort((a, b) => {
        const channelOrder = channelRank[a.channel] - channelRank[b.channel];
        return channelOrder || (parseDate(b.created_at)?.getTime() || 0) - (parseDate(a.created_at)?.getTime() || 0);
      });
      return `
        <section class="rule-prefix-card${wildcard ? ' is-wildcard' : ''}" data-prefix-group="${escapeHtml(prefix)}">
          <header class="rule-prefix-header">
            <div class="rule-prefix-identity">
              <div class="rule-prefix-title"><code>${escapeHtml(prefix)}</code>${wildcard ? '<span class="fallback-badge">兜底</span>' : ''}</div>
              <span class="rule-prefix-address">${escapeHtml(address)}</span>
            </div>
            <div class="rule-prefix-summary">
              <span>${sortedRules.length} 条规则</span>
              <button type="button" class="btn btn-sm" data-add-prefix="${escapeHtml(prefix)}" aria-label="为 ${escapeHtml(prefix)} 前缀添加规则">+ 添加</button>
            </div>
          </header>
          ${wildcard ? '<p class="wildcard-note">匹配所有收件前缀，并与对应的具体前缀规则同时生效；它不是仅在没有其他规则时执行的 fallback。</p>' : ''}
          <div class="rule-group-list" role="list">
            ${sortedRules.map((rule) => renderRuleRow(rule)).join('')}
          </div>
        </section>`;
    }).join('');
  }

  function renderRuleRow(rule) {
      const key = keyOf(rule);
      const channel = CHANNELS[rule.channel];
      const testButton = rule.channel === 'tg' || rule.channel === 'bark'
        ? `<button class="icon-btn" data-test="${key}" title="发送测试消息" aria-label="发送测试消息">${ICONS.send}</button>`
        : '';
      return `
        <article class="rule-group-row${rule.enabled ? '' : ' is-disabled'}" data-id="${key}" role="listitem">
          <div class="rule-group-channel"><span class="channel-badge channel-${rule.channel}">${escapeHtml(channel.label)}</span></div>
          <div class="rule-group-target">${renderTarget(rule)}</div>
          <div class="rule-group-status">
            <label class="switch">
              <input type="checkbox" data-toggle="${key}" ${rule.enabled ? 'checked' : ''} aria-label="${escapeHtml(channel.toggleLabel)}">
              <span class="switch-track"></span>
            </label>
            <span>${rule.enabled ? '已启用' : '已停用'}</span>
          </div>
          <time class="rule-group-time" title="${escapeHtml(fullTime(rule.created_at))}">${escapeHtml(relTime(rule.created_at))}</time>
          <div class="rule-actions">${testButton}<button class="icon-btn" data-edit="${key}" title="编辑规则" aria-label="编辑规则">${ICONS.edit}</button><button class="icon-btn danger" data-del="${key}" title="删除" aria-label="删除">${ICONS.trash}</button></div>
        </article>`;
  }

  function telegramErrorHelp(description) {
    const value = description.toLowerCase();
    if (value.includes('chat not found')) {
      return '该 Bot 找不到这个会话。私聊请先向当前 Bot 发送 /start；群组或频道请确认已添加当前 Bot，并重新核对 Chat ID。';
    }
    if (value.includes('unauthorized')) {
      return 'Bot Token 无效或已被 BotFather 撤销，请到“推送目标”编辑当前规则选择的 Bot。';
    }
    if (value.includes('blocked by the user')) {
      return '该用户已阻止 Bot，需要先在 Telegram 中解除阻止并重新开始会话。';
    }
    if (value.includes('not enough rights') || value.includes('chat_admin_required')) {
      return 'Bot 在目标群组或频道中权限不足，请授予发送消息所需权限。';
    }
    if (value.includes('too many requests')) {
      return 'Telegram 正在限流，请稍后再试。';
    }
    return '请根据 Telegram 原始返回检查当前规则选择的 Bot、Chat ID、会话状态和 Bot 权限。';
  }

  function showTestError(error, rule) {
    const telegram = error.details?.telegram;
    const description = telegram?.description || error.message;
    const errorCode = telegram?.error_code ?? '—';
    const httpStatus = telegram?.http_status ?? error.status ?? '—';
    const target = CHANNELS[rule.channel].targetOf(rule);
    const copyValue = [
      `规则: ${rule.prefix} → ${target}`,
      `HTTP 状态: ${httpStatus}`,
      `Telegram 错误码: ${errorCode}`,
      `Telegram 返回: ${description}`,
    ].join('\n');

    const overlay = openModal(`
      <div class="modal-header">
        <div class="telegram-error-title">${ICONS.alert}<h3 class="modal-title">Telegram 测试失败</h3></div>
        <button class="icon-btn" data-act="close" title="关闭" aria-label="关闭">${ICONS.close}</button>
      </div>
      <div class="modal-body">
        <dl class="detail-meta telegram-error-meta">
          <dt>规则</dt><dd>${escapeHtml(rule.prefix)} → ${escapeHtml(target)}</dd>
          <dt>请求状态</dt><dd>HTTP ${escapeHtml(httpStatus)}</dd>
          <dt>错误码</dt><dd>${escapeHtml(errorCode)}</dd>
        </dl>
        <div class="diagnostic-block">
          <span class="diagnostic-label">Telegram 原始返回</span>
          <pre>${escapeHtml(description)}</pre>
        </div>
        <p class="diagnostic-help">${escapeHtml(telegramErrorHelp(description))}</p>
      </div>
      <div class="modal-footer">
        <button class="btn" data-act="copy-error">${ICONS.copy} 复制错误详情</button>
        <button class="btn btn-primary" data-act="close">关闭</button>
      </div>
    `);

    overlay.querySelectorAll('[data-act="close"]').forEach((button) => {
      button.addEventListener('click', closeModal);
    });
    overlay.querySelector('[data-act="copy-error"]').addEventListener('click', () => {
      copyText(copyValue, '错误详情');
    });
  }

  function openEdit(rule) {
    const channel = CHANNELS[rule.channel];
    const targetFields = rule.channel === 'forward' ? `
      <div class="field">
        <label class="field-label" for="edit-rule-destination">邮件目标</label>
        <select id="edit-rule-destination" name="destination_id" required>${emailDestinationOptions(rule.destination_id)}</select>
      </div>` : rule.channel === 'bark' ? `
      <div class="field">
        <label class="field-label" for="edit-rule-bark">Bark 目标</label>
        <select id="edit-rule-bark" name="endpoint_id" required>${barkEndpointOptions(rule.endpoint_id)}</select>
      </div>` : `
      <div class="field">
        <label class="field-label" for="edit-rule-value">Chat ID</label>
        <input id="edit-rule-value" name="chat_id" type="text" value="${escapeHtml(rule.chat_id)}" required>
      </div>
      <div class="field">
        <label class="field-label" for="edit-rule-bot">发送 Bot</label>
        <select id="edit-rule-bot" name="bot_id" required>${telegramBotOptions(rule.bot_id)}</select>
      </div>`;
    const overlay = openModal(`
      <form class="edit-rule-form" novalidate>
        <div class="modal-header">
          <h3 class="modal-title">${escapeHtml(channel.editTitle)}</h3>
          <button type="button" class="icon-btn" data-act="close" title="关闭" aria-label="关闭">${ICONS.close}</button>
        </div>
        <div class="modal-body edit-rule-fields">
          <div class="field">
            <label class="field-label" for="edit-rule-prefix">收件前缀</label>
            <input id="edit-rule-prefix" name="prefix" type="text" value="${escapeHtml(rule.prefix)}" autocomplete="off" spellcheck="false" required>
          </div>
          ${targetFields}
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" data-act="close">取消</button>
          <button type="submit" class="btn btn-primary">保存修改</button>
        </div>
      </form>
    `, { small: true });

    overlay.querySelectorAll('[data-act="close"]').forEach((button) => {
      button.addEventListener('click', closeModal);
    });

    const editForm = overlay.querySelector('.edit-rule-form');
    editForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(
        [...new FormData(editForm)].map(([key, value]) => [key, String(value).trim()])
      );
      const problem = channel.validate(data);
      if (problem) {
        toast(problem, 'error');
        return;
      }

      const saveButton = editForm.querySelector('button[type="submit"]');
      saveButton.disabled = true;
      try {
        await api(`${channel.endpoint}/${rule.id}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        });
        closeModal();
        toast('规则已更新', 'success');
        await load();
      } catch (error) {
        if (error.status !== 401) toast(`保存失败：${error.message}`, 'error');
      } finally {
        saveButton.disabled = false;
      }
    });

    overlay.querySelector('#edit-rule-prefix').focus();
  }

  function setChannel(channelName) {
    const channel = CHANNELS[channelName] ? channelName : 'forward';
    document.querySelectorAll('[data-channel-fields]').forEach((container) => {
      const active = container.dataset.channelFields === channel;
      container.hidden = !active;
      container.querySelectorAll('input, select').forEach((control) => {
        const emptyCatalog = (control.id === 'rule-bot' && !telegramBots.length)
          || (control.id === 'rule-target' && !emailDestinations.length)
          || (control.id === 'rule-bark' && !barkEndpoints.length);
        control.disabled = !active || emptyCatalog;
      });
    });
    document.querySelectorAll('[data-channel-hint]').forEach((hint) => {
      hint.hidden = hint.dataset.channelHint !== channel;
    });
  }

  function init() {
    const form = $('#rules-form');
    const channelSelect = $('#rule-channel');
    setChannel(channelSelect.value);

    channelSelect.addEventListener('change', () => setChannel(channelSelect.value));
    $('#rule-add-bot').addEventListener('click', () => {
      openTelegramBotCreateModal({
        onCreated: async (created) => {
          await loadTelegramBotCatalog();
          const select = $('#rule-bot');
          select.value = String(created.id);
          loadedTabs.delete('destinations');
          select.focus();
        },
      });
    });
    $('#rule-add-email-target').addEventListener('click', () => {
      openEmailDestinationCreateModal({
        onCreated: async (created) => {
          await loadDestinationCatalogs();
          const select = $('#rule-target');
          select.value = String(created.id);
          loadedTabs.delete('destinations');
          select.focus();
        },
      });
    });
    $('#rule-add-bark').addEventListener('click', () => {
      openBarkDestinationCreateModal({
        onCreated: async (created) => {
          await loadDestinationCatalogs();
          const select = $('#rule-bark');
          select.value = String(created.id);
          loadedTabs.delete('destinations');
          select.focus();
        },
      });
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const channelName = channelSelect.value;
      const channel = CHANNELS[channelName];
      const data = Object.fromEntries(
        [...new FormData(form)].map(([key, value]) => [key, String(value).trim()])
      );
      const payload = channelName === 'forward'
        ? { prefix: data.prefix, destination_id: data.destination_id }
        : channelName === 'tg'
          ? { prefix: data.prefix, chat_id: data.chat_id, bot_id: data.bot_id }
          : { prefix: data.prefix, endpoint_id: data.endpoint_id };
      const problem = channel.validate(payload);
      if (problem) {
        toast(problem, 'error');
        return;
      }

      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await api(channel.endpoint, { method: 'POST', body: JSON.stringify(payload) });
        form.reset();
        setChannel(channelSelect.value);
        $('#rule-prefix').focus();
        toast('规则已添加', 'success');
        await load();
      } catch (error) {
        if (error.status !== 401) toast(`添加失败：${error.message}`, 'error');
      } finally {
        button.disabled = false;
      }
    });

    stateEl().addEventListener('click', (event) => {
      if (event.target.closest('[data-retry]')) load();
    });

    listEl().addEventListener('change', async (event) => {
      const toggle = event.target.closest('[data-toggle]');
      if (!toggle) return;
      const rule = byId.get(toggle.dataset.toggle);
      if (!rule) return;
      const enabled = toggle.checked;
      toggle.disabled = true;
      try {
        await api(`${CHANNELS[rule.channel].endpoint}/${rule.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled }),
        });
        rule.enabled = enabled ? 1 : 0;
        const row = toggle.closest('.rule-group-row');
        row?.classList.toggle('is-disabled', !enabled);
        const status = row?.querySelector('.rule-group-status > span');
        if (status) status.textContent = enabled ? '已启用' : '已停用';
        toast(enabled ? '规则已启用' : '规则已停用', 'success');
      } catch (error) {
        toggle.checked = !enabled;
        if (error.status !== 401) toast(`操作失败：${error.message}`, 'error');
      } finally {
        toggle.disabled = false;
      }
    });

    listEl().addEventListener('click', async (event) => {
      const addButton = event.target.closest('[data-add-prefix]');
      if (addButton) {
        const prefixInput = $('#rule-prefix');
        prefixInput.value = addButton.dataset.addPrefix;
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        prefixInput.focus({ preventScroll: true });
        return;
      }

      const testButton = event.target.closest('[data-test]');
      if (testButton) {
        const rule = byId.get(testButton.dataset.test);
        if (!rule || !['tg', 'bark'].includes(rule.channel) || testButton.disabled) return;
        const original = testButton.innerHTML;
        testButton.disabled = true;
        testButton.setAttribute('aria-busy', 'true');
        testButton.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
        try {
          await api(`${CHANNELS[rule.channel].endpoint}/${rule.id}/test`, { method: 'POST' });
          toast(rule.channel === 'tg'
            ? `已通过 ${rule.bot_name || '所选 Bot'} 发送到 ${rule.chat_id}`
            : `已向 ${rule.endpoint_name} 发送 Bark 测试通知`, 'success');
        } catch (error) {
          if (error.status !== 401) {
            if (rule.channel === 'tg') showTestError(error, rule);
            else toast(`Bark 测试失败：${error.details?.bark?.description || error.message}`, 'error');
          }
        } finally {
          testButton.disabled = false;
          testButton.removeAttribute('aria-busy');
          testButton.innerHTML = original;
        }
        return;
      }

      const editButton = event.target.closest('[data-edit]');
      if (editButton) {
        const rule = byId.get(editButton.dataset.edit);
        if (rule) openEdit(rule);
        return;
      }

      const deleteButton = event.target.closest('[data-del]');
      if (!deleteButton) return;
      const rule = byId.get(deleteButton.dataset.del);
      if (!rule) return;
      const channel = CHANNELS[rule.channel];
      const confirmed = await confirmDialog({
        title: '删除规则',
        message: `确定删除前缀 “${rule.prefix}” → ${channel.targetOf(rule)} 的规则？`,
      });
      if (!confirmed) return;
      try {
        await api(`${channel.endpoint}/${rule.id}`, { method: 'DELETE' });
        toast('规则已删除', 'success');
        await load();
      } catch (error) {
        if (error.status !== 401) toast(`删除失败：${error.message}`, 'error');
      }
    });
  }

  return { load, init };
})();

// ── Logs view ──

const logsView = (() => {
  const CATEGORY_LABELS = {
    delivery: '投递',
    auth: '认证',
    bot: 'Bot',
    rule: '规则',
    settings: '设置',
    email: '邮件',
  };
  const DETAIL_LABELS = {
    email_id: '邮件 ID',
    downstream_id: '下游 ID',
    rule_id: '规则 ID',
    channel: '渠道',
    target: '目标',
    attempt: '尝试次数',
    bot_id: 'Bot ID',
    bot_name: 'Bot 名称',
    name: '名称',
    username: '用户名',
    prefix: '前缀',
    chat_id: 'Chat ID',
    target_email: '目标邮箱',
    enabled: '启用状态',
    provider: '模型来源',
    model: '模型',
    base_url: 'Base URL',
    error: '错误',
    token_changed: 'Token 已更新',
    previous_name: '原名称',
    requested_name: '新名称',
  };
  const SENSITIVE_DETAIL_RE = /password|token|api[_-]?key|secret/i;
  const LIMIT = 30;
  let page = 1;
  let query = '';
  let category = '';
  let status = '';
  let seq = 0;

  const list = () => $('#logs-list');
  const state = () => $('#logs-state');

  function showList() {
    state().hidden = true;
    list().hidden = false;
  }

  function showLogsState(html) {
    list().hidden = true;
    state().hidden = false;
    state().innerHTML = html;
  }

  function renderLoading() {
    showList();
    list().innerHTML = Array.from({ length: 6 }, (_, index) => `
      <div class="log-entry" style="animation-delay:${index * 24}ms">
        <div class="log-rail"><span class="log-dot"></span></div>
        <div class="log-main"><span class="skeleton" style="width:${58 + (index % 3) * 9}%"></span><br><span class="skeleton" style="width:32%;height:10px;margin-top:7px"></span></div>
      </div>`).join('');
  }

  async function load({ quiet = false } = {}) {
    const my = ++seq;
    if (!quiet) renderLoading();

    const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
    if (query) params.set('q', query);
    if (category) params.set('category', category);
    if (status) params.set('status', status);

    try {
      const result = await api(`/logs?${params}`);
      if (my !== seq) return;
      render(result);
    } catch (error) {
      if (my !== seq || error.status === 401) return;
      if (!quiet || !list().children.length) showLogsState(errorStateHtml(error.message));
    }
  }

  function render({ data, total, page: currentPage, limit }) {
    $('#log-count').textContent = total ? `共 ${total} 条` : '';
    const totalPages = Math.max(1, Math.ceil(total / limit));
    $('#logs-pagination').hidden = totalPages <= 1;
    $('#logs-page-info').textContent = `第 ${currentPage} / ${totalPages} 页 · 共 ${total} 条`;
    $('#logs-page-prev').disabled = currentPage <= 1;
    $('#logs-page-next').disabled = currentPage >= totalPages;

    if (!data?.length) {
      $('#logs-pagination').hidden = true;
      showLogsState(emptyStateHtml(
        ICONS.eye,
        query || category || status ? '没有匹配的日志' : '暂无操作日志',
        query || category || status ? '尝试调整搜索词或筛选条件' : '后续管理操作和投递结果会显示在这里',
      ));
      return;
    }

    showList();
    list().innerHTML = data.map((item, index) => {
      const details = Object.entries(item.details || {})
        .filter(([key, value]) => !SENSITIVE_DETAIL_RE.test(key) && value !== '' && value !== null)
        .map(([key, value]) => `
          <dt>${escapeHtml(DETAIL_LABELS[key] || key)}</dt>
          <dd>${escapeHtml(typeof value === 'object' ? JSON.stringify(value) : value)}</dd>`)
        .join('');
      const actor = item.actor === 'system' ? '系统' : '管理员';
      const statusIcon = item.status === 'success' ? ICONS.check : item.status === 'failed' ? ICONS.alert : ICONS.eye;
      return `
        <article class="log-entry log-${escapeHtml(item.status)}" style="animation-delay:${Math.min(index, 8) * 22}ms">
          <div class="log-rail"><span class="log-dot">${statusIcon}</span></div>
          <div class="log-main">
            <div class="log-heading">
              <span class="log-badge" data-category="${escapeHtml(item.category)}">${escapeHtml(CATEGORY_LABELS[item.category] || item.category)}</span>
              <strong class="log-summary">${escapeHtml(item.summary)}</strong>
            </div>
            <div class="log-meta">
              <span>${escapeHtml(actor)}</span>
              <span><code>${escapeHtml(item.action)}</code></span>
              ${item.ip_address ? `<span>IP ${escapeHtml(item.ip_address)}</span>` : ''}
            </div>
            ${details ? `<details class="log-details"><summary>查看详情</summary><dl class="log-detail-grid">${details}</dl></details>` : ''}
          </div>
          <time class="log-time" title="${escapeHtml(fullTime(item.created_at))}">${escapeHtml(relTime(item.created_at))}</time>
        </article>`;
    }).join('');
  }

  function init() {
    $('#log-search').addEventListener('input', debounce((event) => {
      query = event.target.value.trim();
      page = 1;
      load();
    }, 300));
    $('#log-category').addEventListener('change', (event) => {
      category = event.target.value;
      page = 1;
      load();
    });
    $('#log-status').addEventListener('change', (event) => {
      status = event.target.value;
      page = 1;
      load();
    });
    $('#logs-refresh').addEventListener('click', () => load());
    $('#logs-page-prev').addEventListener('click', () => {
      if (page > 1) { page -= 1; load(); }
    });
    $('#logs-page-next').addEventListener('click', () => {
      page += 1;
      load();
    });
    state().addEventListener('click', (event) => {
      if (event.target.closest('[data-retry]')) load();
    });
    setInterval(() => {
      if (activeTab === 'logs' && !$('#app').classList.contains('hidden')) {
        void load({ quiet: true });
      }
    }, 15_000);
  }

  return { load, init };
})();

// ── Settings view ──

const settingsView = (() => {
  const MODEL_PLACEHOLDER = {
    'workers-ai': '@cf/meta/llama-3.2-3b-instruct（留空使用默认）',
    'openai': 'gpt-4o-mini（留空使用默认）',
  };

  function renderEmailDestinations() {
    const list = $('#email-destinations-list');
    $('#email-destination-count').textContent = `${emailDestinations.length} 个目标`;
    list.innerHTML = emailDestinations.length ? emailDestinations.map((item) => `
      <article class="telegram-bot-row destination-row">
        <span class="telegram-mark email-target-mark">@</span>
        <div class="telegram-bot-identity"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.email_address)}</span></div>
        <div class="telegram-bot-meta"><span>${item.rule_count} 条规则</span></div>
        <div class="telegram-bot-actions">
          <button class="icon-btn" data-edit-email-target="${item.id}" title="编辑目标">${ICONS.edit}</button>
          <button class="icon-btn danger" data-delete-email-target="${item.id}" title="删除目标" ${item.rule_count ? 'disabled' : ''}>${ICONS.trash}</button>
        </div>
      </article>`).join('') : `
      <div class="telegram-bot-empty"><span class="telegram-mark email-target-mark">@</span><div><strong>还没有邮件目标</strong><small>添加后即可在路由规则中复用</small></div></div>`;
  }

  function renderBarkEndpoints() {
    const list = $('#bark-endpoints-list');
    $('#bark-endpoint-count').textContent = `${barkEndpoints.length} 个目标`;
    list.innerHTML = barkEndpoints.length ? barkEndpoints.map((item) => `
      <article class="telegram-bot-row destination-row">
        <span class="telegram-mark bark-mark">B</span>
        <div class="telegram-bot-identity"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.server_url)}</span></div>
        <div class="telegram-bot-meta"><code>••••${escapeHtml(item.key_hint)}</code><span>${item.rule_count} 条规则</span></div>
        <div class="telegram-bot-actions">
          <button class="btn btn-sm" data-test-bark="${item.id}">${ICONS.send} 测试</button>
          <button class="icon-btn" data-edit-bark="${item.id}" title="编辑目标">${ICONS.edit}</button>
          <button class="icon-btn danger" data-delete-bark="${item.id}" title="删除目标" ${item.rule_count ? 'disabled' : ''}>${ICONS.trash}</button>
        </div>
      </article>`).join('') : `
      <div class="telegram-bot-empty"><span class="telegram-mark bark-mark">B</span><div><strong>还没有 Bark 目标</strong><small>添加设备后可用于路由和手动推送</small></div></div>`;
  }

  async function refreshDestinations() {
    await loadDestinationCatalogs();
    renderEmailDestinations();
    renderBarkEndpoints();
  }

  function openDestinationEdit(kind, item) {
    const isEmail = kind === 'email';
    const overlay = openModal(`
      <form class="edit-destination-form" novalidate>
        <div class="modal-header">
          <div><h3 class="modal-title">编辑${isEmail ? '邮件' : ' Bark'}目标</h3><p class="modal-subtitle">${isEmail ? escapeHtml(item.email_address) : `Device Key 尾号 ${escapeHtml(item.key_hint)}`}</p></div>
          <button type="button" class="icon-btn" data-act="close">${ICONS.close}</button>
        </div>
        <div class="modal-body edit-rule-fields">
          <div class="field"><label class="field-label">名称</label><input name="name" type="text" maxlength="50" value="${escapeHtml(item.name)}" required></div>
          ${isEmail ? `
            <div class="field"><label class="field-label">邮箱地址</label><input name="email_address" type="email" value="${escapeHtml(item.email_address)}" required></div>` : `
            <div class="field"><label class="field-label">Server</label><input name="server_url" type="url" value="${escapeHtml(item.server_url)}" required></div>
            <div class="field"><label class="field-label">新 Device Key</label><input name="device_key" type="password" placeholder="留空保持当前 Key" autocomplete="new-password"><small class="field-help">不会回显当前 Key。</small></div>`}
        </div>
        <div class="modal-footer"><button type="button" class="btn" data-act="close">取消</button><button type="submit" class="btn btn-primary">保存修改</button></div>
      </form>`, { small: true });
    overlay.querySelectorAll('[data-act="close"]').forEach((button) => button.addEventListener('click', closeModal));
    const form = overlay.querySelector('form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, String(value).trim()]));
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await api(`/destinations/${isEmail ? 'emails' : 'bark'}/${item.id}`, { method: 'PUT', body: JSON.stringify(data) });
        closeModal();
        await refreshDestinations();
        loadedTabs.delete('rules');
        toast('目标已更新', 'success');
      } catch (error) {
        if (error.status !== 401) toast(`保存失败：${error.message}`, 'error');
      } finally {
        button.disabled = false;
      }
    });
  }

  function renderTelegramBots() {
    const list = $('#telegram-bots-list');
    $('#telegram-bot-count').textContent = `${telegramBots.length} 个 Bot`;

    if (!telegramBots.length) {
      list.innerHTML = `
        <div class="telegram-bot-empty">
          <span class="telegram-mark">${ICONS.send}</span>
          <div><strong>还没有 Bot</strong><small>填写上方信息，验证通过后即可用于推送规则</small></div>
        </div>`;
    } else {
      list.innerHTML = telegramBots.map((bot) => `
        <article class="telegram-bot-row" data-bot-id="${bot.id}">
          <span class="telegram-mark">${ICONS.send}</span>
          <div class="telegram-bot-identity">
            <strong>${escapeHtml(bot.name)}</strong>
            <span>${bot.username ? `@${escapeHtml(bot.username)}` : '未返回用户名'}</span>
          </div>
          <div class="telegram-bot-meta">
            <code>••••${escapeHtml(bot.token_hint)}</code>
            <span>${bot.rule_count} 条规则</span>
          </div>
          <div class="telegram-bot-actions">
            <button class="btn btn-sm" data-test-bot="${bot.id}">${ICONS.check} 验证</button>
            <button class="icon-btn" data-edit-bot="${bot.id}" title="编辑 Bot" aria-label="编辑 Bot">${ICONS.edit}</button>
            <button class="icon-btn danger" data-delete-bot="${bot.id}" title="删除 Bot" aria-label="删除 Bot" ${bot.rule_count ? 'disabled' : ''}>${ICONS.trash}</button>
          </div>
        </article>
      `).join('');
    }
  }

  async function refreshTelegramBots() {
    await loadTelegramBotCatalog();
    renderTelegramBots();
  }

  function openTelegramBotEdit(bot) {
    const overlay = openModal(`
      <form class="edit-telegram-bot-form" novalidate>
        <div class="modal-header">
          <div>
            <h3 class="modal-title">编辑 Telegram Bot</h3>
            <p class="modal-subtitle">@${escapeHtml(bot.username || 'unknown')} · Token 尾号 ${escapeHtml(bot.token_hint)}</p>
          </div>
          <button type="button" class="icon-btn" data-act="close" title="关闭" aria-label="关闭">${ICONS.close}</button>
        </div>
        <div class="modal-body edit-rule-fields">
          <div class="field">
            <label class="field-label" for="edit-bot-name">名称</label>
            <input id="edit-bot-name" name="name" type="text" maxlength="50" value="${escapeHtml(bot.name)}" autocomplete="off" spellcheck="false" required>
          </div>
          <div class="field">
            <label class="field-label" for="edit-bot-token">新 Bot Token</label>
            <input id="edit-bot-token" name="token" type="password" placeholder="留空则保持当前 Token" autocomplete="new-password" spellcheck="false">
            <small class="field-help">只修改名称时无需再次填写 Token；保存仍会验证当前 Bot 身份。</small>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" data-act="close">取消</button>
          <button type="submit" class="btn btn-primary">验证并保存</button>
        </div>
      </form>
    `, { small: true });

    overlay.querySelectorAll('[data-act="close"]').forEach((button) => {
      button.addEventListener('click', closeModal);
    });
    const form = overlay.querySelector('.edit-telegram-bot-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = form.elements.name.value.trim();
      const token = form.elements.token.value.trim();
      if (!name) {
        toast('请填写 Bot 名称', 'error');
        return;
      }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.innerHTML = '<span class="spinner" aria-hidden="true"></span>验证中…';
      try {
        await api(`/settings/telegram-bots/${bot.id}`, {
          method: 'PUT',
          body: JSON.stringify({ name, token }),
        });
        closeModal();
        await refreshTelegramBots();
        toast('Bot 已更新', 'success');
      } catch (error) {
        if (error.status !== 401) toast(`保存失败：${telegramErrorMessage(error)}`, 'error');
      } finally {
        button.disabled = false;
        button.textContent = '验证并保存';
      }
    });
    overlay.querySelector('#edit-bot-name').focus();
  }

  function syncAiFields() {
    const provider = $('#ai-provider').value;
    const visible = {
      model: provider !== 'none',
      base_url: provider === 'openai',
      api_key: provider === 'openai',
    };
    document.querySelectorAll('[data-ai-field]').forEach((el) => {
      el.hidden = !visible[el.dataset.aiField];
    });
    if (provider !== 'none') {
      $('#ai-model').placeholder = MODEL_PLACEHOLDER[provider];
    }
  }

  async function load() {
    try {
      const [{ ai }] = await Promise.all([
        api('/settings'),
        refreshTelegramBots(),
        refreshDestinations(),
      ]);
      $('#ai-provider').value = ai.provider || 'none';
      $('#ai-model').value = ai.model || '';
      $('#ai-base').value = ai.base_url || '';
      $('#ai-key').value = ai.api_key || '';
      syncAiFields();
    } catch (err) {
      if (err.status !== 401) toast(`加载设置失败：${err.message}`, 'error');
    }
  }

  function init() {
    $('#ai-provider').addEventListener('change', syncAiFields);

    $('#telegram-bot-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = $('#telegram-bot-name').value.trim();
      const token = $('#telegram-bot-token').value.trim();
      if (!name || !token) {
        toast('请填写 Bot 名称和 Token', 'error');
        return;
      }

      const button = event.target.querySelector('button[type="submit"]');
      button.disabled = true;
      button.innerHTML = '<span class="spinner" aria-hidden="true"></span>验证中…';
      try {
        await api('/settings/telegram-bots', {
          method: 'POST',
          body: JSON.stringify({ name, token }),
        });
        event.target.reset();
        await refreshTelegramBots();
        toast('Bot 已验证并添加', 'success');
      } catch (error) {
        if (error.status !== 401) toast(`添加失败：${telegramErrorMessage(error)}`, 'error');
      } finally {
        button.disabled = false;
        button.textContent = '验证并添加';
      }
    });

    $('#telegram-bots-list').addEventListener('click', async (event) => {
      const editButton = event.target.closest('[data-edit-bot]');
      if (editButton) {
        const bot = telegramBots.find((item) => String(item.id) === editButton.dataset.editBot);
        if (bot) openTelegramBotEdit(bot);
        return;
      }

      const testButton = event.target.closest('[data-test-bot]');
      if (testButton && !testButton.disabled) {
        const bot = telegramBots.find((item) => String(item.id) === testButton.dataset.testBot);
        if (!bot) return;
        testButton.disabled = true;
        testButton.innerHTML = '<span class="spinner" aria-hidden="true"></span>验证中…';
        try {
          await api(`/settings/telegram-bots/${bot.id}/test`, { method: 'POST' });
          await refreshTelegramBots();
          toast(`${bot.name} Token 有效`, 'success');
        } catch (error) {
          if (error.status !== 401) toast(`验证失败：${telegramErrorMessage(error)}`, 'error');
        }
        return;
      }

      const deleteButton = event.target.closest('[data-delete-bot]');
      if (!deleteButton || deleteButton.disabled) return;
      const bot = telegramBots.find((item) => String(item.id) === deleteButton.dataset.deleteBot);
      if (!bot) return;
      const confirmed = await confirmDialog({
        title: '删除 Telegram Bot',
        message: `确定删除 “${bot.name}” 吗？历史下游记录会保留名称，但无法再用这个 Bot 触发。`,
      });
      if (!confirmed) return;
      try {
        await api(`/settings/telegram-bots/${bot.id}`, { method: 'DELETE' });
        await refreshTelegramBots();
        toast('Bot 已删除', 'success');
      } catch (error) {
        if (error.status !== 401) toast(`删除失败：${error.message}`, 'error');
      }
    });

    $('#email-destination-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = {
        name: $('#email-destination-name').value.trim(),
        email_address: $('#email-destination-address').value.trim(),
      };
      const button = event.target.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await api('/destinations/emails', { method: 'POST', body: JSON.stringify(payload) });
        event.target.reset();
        await refreshDestinations();
        loadedTabs.delete('rules');
        toast('邮件目标已添加', 'success');
      } catch (error) {
        if (error.status !== 401) toast(`添加失败：${error.message}`, 'error');
      } finally { button.disabled = false; }
    });

    $('#email-destinations-list').addEventListener('click', async (event) => {
      const edit = event.target.closest('[data-edit-email-target]');
      if (edit) {
        const item = emailDestinations.find((target) => String(target.id) === edit.dataset.editEmailTarget);
        if (item) openDestinationEdit('email', item);
        return;
      }
      const remove = event.target.closest('[data-delete-email-target]');
      if (!remove || remove.disabled) return;
      const item = emailDestinations.find((target) => String(target.id) === remove.dataset.deleteEmailTarget);
      if (!item || !await confirmDialog({ title: '删除邮件目标', message: `确定删除“${item.name}”吗？` })) return;
      try {
        await api(`/destinations/emails/${item.id}`, { method: 'DELETE' });
        await refreshDestinations();
        loadedTabs.delete('rules');
        toast('邮件目标已删除', 'success');
      } catch (error) { if (error.status !== 401) toast(`删除失败：${error.message}`, 'error'); }
    });

    $('#bark-endpoint-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = {
        name: $('#bark-endpoint-name').value.trim(),
        server_url: $('#bark-server-url').value.trim(),
        device_key: $('#bark-device-key').value.trim(),
      };
      const button = event.target.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await api('/destinations/bark', { method: 'POST', body: JSON.stringify(payload) });
        event.target.reset();
        $('#bark-server-url').value = 'https://api.day.app';
        await refreshDestinations();
        loadedTabs.delete('rules');
        toast('Bark 目标已添加，可点击测试验证', 'success');
      } catch (error) { if (error.status !== 401) toast(`添加失败：${error.message}`, 'error'); }
      finally { button.disabled = false; }
    });

    $('#bark-endpoints-list').addEventListener('click', async (event) => {
      const test = event.target.closest('[data-test-bark]');
      if (test && !test.disabled) {
        const item = barkEndpoints.find((target) => String(target.id) === test.dataset.testBark);
        if (!item) return;
        test.disabled = true;
        try {
          await api(`/destinations/bark/${item.id}/test`, { method: 'POST' });
          toast(`已向 ${item.name} 发送测试通知`, 'success');
        } catch (error) {
          if (error.status !== 401) toast(`测试失败：${error.details?.bark?.description || error.message}`, 'error');
        } finally { test.disabled = false; }
        return;
      }
      const edit = event.target.closest('[data-edit-bark]');
      if (edit) {
        const item = barkEndpoints.find((target) => String(target.id) === edit.dataset.editBark);
        if (item) openDestinationEdit('bark', item);
        return;
      }
      const remove = event.target.closest('[data-delete-bark]');
      if (!remove || remove.disabled) return;
      const item = barkEndpoints.find((target) => String(target.id) === remove.dataset.deleteBark);
      if (!item || !await confirmDialog({ title: '删除 Bark 目标', message: `确定删除“${item.name}”吗？` })) return;
      try {
        await api(`/destinations/bark/${item.id}`, { method: 'DELETE' });
        await refreshDestinations();
        loadedTabs.delete('rules');
        toast('Bark 目标已删除', 'success');
      } catch (error) { if (error.status !== 401) toast(`删除失败：${error.message}`, 'error'); }
    });

    $('#ai-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const provider = $('#ai-provider').value;
      const payload = {
        provider,
        model: $('#ai-model').value.trim(),
        base_url: $('#ai-base').value.trim(),
        api_key: $('#ai-key').value.trim(),
      };

      if (provider === 'openai' && !payload.api_key) {
        toast('OpenAI 兼容接口需要填写 API Key', 'error');
        return;
      }
      if (payload.base_url && !/^https?:\/\//.test(payload.base_url)) {
        toast('API Base URL 需以 http(s):// 开头', 'error');
        return;
      }

      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        await api('/settings/ai', { method: 'PUT', body: JSON.stringify(payload) });
        toast('模型配置已保存', 'success');
      } catch (err) {
        if (err.status !== 401) toast(`保存失败：${err.message}`, 'error');
      } finally {
        btn.disabled = false;
      }
    });

    $('#password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const newToken = $('#pw-new').value.trim();
      const confirm = $('#pw-confirm').value.trim();

      if (newToken.length < 8) {
        toast('密码长度至少 8 位', 'error');
        return;
      }
      if (/\s/.test(newToken)) {
        toast('密码不能包含空白字符', 'error');
        return;
      }
      if (newToken !== confirm) {
        toast('两次输入的密码不一致', 'error');
        return;
      }

      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const session = await api('/settings/password', {
          method: 'PUT',
          body: JSON.stringify({ new_token: newToken }),
        });
        localStorage.setItem(TOKEN_KEY, session.token);
        e.target.reset();
        toast('管理密码已更新，当前会话已切换', 'success');
      } catch (err) {
        if (err.status !== 401) toast(`更新失败：${err.message}`, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  return { load, init };
})();

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
