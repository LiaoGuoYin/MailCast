import { $, ICONS, api, barkEndpointOptions, barkEndpoints, closeModal, confirmDialog, copyText } from './app.js';
import { debounce, emptyStateHtml, errorStateHtml, escapeHtml, extractCode, fullTime } from './app.js';
import { loadDestinationCatalogs, loadTelegramBotCatalog, openModal, relTime, switchTab } from './app.js';
import { showState, showTable, telegramBotOptions, telegramBots, toast } from './app.js';
import { buildEmailPreviewDocument, fitPreviewFrame, observePreviewImages } from './email-preview.js';
import { BLOCK_REMOTE_CONTENT_KEY } from './storage.js';

// ── Emails view (Master-Detail minimalist webmail) ──

const AVATAR_TONES = ['violet', 'blue', 'teal', 'emerald', 'amber', 'rose', 'indigo', 'cyan'];

function senderIdentity(address) {
  const raw = String(address || '').trim();
  const at = raw.lastIndexOf('@');
  const local = at > 0 ? raw.slice(0, at) : raw;
  const domain = at > 0 ? raw.slice(at + 1).toLowerCase() : '';
  const seed = domain || raw.toLowerCase();
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  const tone = AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length];

  const domainLabel = domain.split('.')[0] || '';
  const genericLocal = /^(?:no-?reply|noreply|notification|notifications|notify|mail|mailer|info|support|hello|team|admin|service|billing|updates?|news|alert|alerts|security|postmaster|bounce)$/i.test(local);
  const displaySource = (genericLocal && domainLabel) ? domainLabel : (local || domain || '?');
  const initialMatch = displaySource.match(/[a-zA-Z0-9\u4e00-\u9fff]/);
  const initial = (initialMatch ? initialMatch[0] : '?').toUpperCase();

  return {
    address: raw || '未知发件人',
    local,
    domain,
    initial,
    tone,
  };
}

function looksCssPolluted(text) {
  if (!text) return false;
  return /@media\s*\(|box-sizing\s*:|prefers-color-scheme\s*:|mso-hide\s*:/i.test(text);
}

function emailDomain(address) {
  const raw = String(address || '').trim();
  const at = raw.lastIndexOf('@');
  return at > 0 && at < raw.length - 1 ? raw.slice(at + 1).toLowerCase() : '';
}

function replySubject(subject) {
  const value = String(subject || '').trim() || '（无主题）';
  return /^re:\s*/i.test(value) ? value : `Re: ${value}`;
}

function buildReplyQuote(email, readablePlainText) {
  const author = email.reply_to_addr || email.from_addr || '发件人';
  const header = `在 ${fullTime(email.created_at)}，${author} 写道：`;
  const snippet = String(readablePlainText || '').trim().slice(0, 2000);
  const quoted = snippet
    ? snippet.split(/\r?\n/).map((line) => `> ${line}`).join('\n')
    : '> （无正文）';
  return `\n\n${header}\n${quoted}`;
}

function readBlockRemotePref() {
  try {
    return localStorage.getItem(BLOCK_REMOTE_CONTENT_KEY) === '1';
  } catch {
    return false;
  }
}

function writeBlockRemotePref(blocked) {
  try {
    if (blocked) localStorage.setItem(BLOCK_REMOTE_CONTENT_KEY, '1');
    else localStorage.removeItem(BLOCK_REMOTE_CONTENT_KEY);
  } catch {
    // Ignore storage errors
  }
}

const EMPTY_READER_HTML = `
  <div class="reader-empty">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="2" y="4" width="20" height="16" rx="2.5"/>
      <path d="m2 7 8.97 5.7a2 2 0 0 0 2.06 0L22 7"/>
    </svg>
    <p>选择左侧邮件查看正文</p>
    <span>支持方向键 ↑ / ↓ 快速切换</span>
  </div>`;

const emailsView = (() => {
  let page = 1;
  let prefix = '';
  let unreadOnly = false;
  let seq = 0;
  let detailSeq = 0;
  let selectedId = null;
  let currentList = [];
  let cleanupReader = null;
  const byId = new Map();
  const LIMIT = 20;

  const shellEl = () => $('#inbox-shell');
  const listEl = () => $('#emails-list');
  const stateEl = () => $('#emails-state');
  const readerEl = () => $('#email-reader');
  const deliveryEl = () => $('#email-delivery');
  let deliveryOpen = window.matchMedia('(min-width: 1120px)').matches;

  function disposeReader() {
    if (cleanupReader) {
      cleanupReader();
      cleanupReader = null;
    }
  }

  function clearSelection() {
    disposeReader();
    selectedId = null;
    shellEl()?.classList.remove('has-selection', 'has-delivery');
    listEl()?.querySelectorAll('.mail-row.is-selected').forEach((row) => {
      row.classList.remove('is-selected');
      row.removeAttribute('aria-current');
    });
    if (readerEl()) readerEl().innerHTML = EMPTY_READER_HTML;
    if (deliveryEl()) {
      deliveryEl().hidden = true;
      deliveryEl().innerHTML = '';
    }
  }

  function syncSelectedRowHighlight() {
    listEl()?.querySelectorAll('.mail-row[data-id]').forEach((row) => {
      const active = selectedId !== null && row.dataset.id === String(selectedId);
      row.classList.toggle('is-selected', active);
      if (active) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    });
  }

  function renderInboxSkeleton(rows = 7) {
    listEl().innerHTML = Array.from({ length: rows }, () => `
      <div class="mail-row mail-row-skeleton" aria-hidden="true">
        <div class="mail-row-body">
          <div class="mail-row-top">
            <span class="skeleton" style="width:130px"></span>
            <span class="skeleton" style="width:46px"></span>
          </div>
          <span class="skeleton" style="width:74%;height:13px"></span>
          <span class="skeleton" style="width:88%;height:11px"></span>
        </div>
      </div>
    `).join('');
  }

  function renderUnreadCount(count) {
    const total = Math.max(0, Number(count) || 0);
    const badge = $('#inbox-unread-count');
    const tab = document.querySelector('[data-tab="emails"]');
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.title = total > 0 ? `${total} 封未读邮件` : '';
    badge.hidden = total === 0;
    tab.setAttribute('aria-label', total > 0 ? `收件箱，${total} 封未读` : '收件箱');
  }

  async function loadUnreadCount() {
    try {
      const result = await api('/emails/unread-count');
      renderUnreadCount(result.unread_count);
    } catch (error) {
      if (error.status !== 401) {
        console.error('Failed to load unread email count', error);
      }
    }
  }

  async function load() {
    const my = ++seq;
    $('#emails-pagination').hidden = true;
    showTable(stateEl(), listEl());
    renderInboxSkeleton();

    let res;
    try {
      let url = `/emails?page=${page}&limit=${LIMIT}`;
      if (prefix) url += `&prefix=${encodeURIComponent(prefix)}`;
      if (unreadOnly) url += '&unread=1';
      res = await api(url);
    } catch (err) {
      if (my !== seq || err.status === 401) return;
      listEl().innerHTML = '';
      showState(stateEl(), listEl(), errorStateHtml(err.message));
      return;
    }
    if (my !== seq) return;
    render(res);
  }

  function render({ data, total, unread_count: unreadCount, page: cur, limit }) {
    byId.clear();
    currentList = data || [];
    $('#email-count').textContent = total > 0 ? `共 ${total} 封` : '';
    renderUnreadCount(unreadCount);

    if (!currentList.length) {
      listEl().innerHTML = '';
      $('#emails-pagination').hidden = true;
      const emptyTitle = unreadOnly
        ? (prefix ? `前缀 “${prefix}” 下没有未读邮件` : '所有邮件均已读')
        : (prefix ? `没有前缀为 “${prefix}” 的邮件` : '暂无邮件');
      const emptySub = unreadOnly
        ? '切换到「全部」可查看历史邮件'
        : (prefix ? '试试其他前缀，或清空筛选条件' : '收到的邮件会自动出现在这里');
      showState(stateEl(), listEl(), emptyStateHtml(ICONS.inbox, emptyTitle, emptySub));
      clearSelection();
      return;
    }

    showTable(stateEl(), listEl());
    for (const e of currentList) byId.set(String(e.id), e);

    listEl().innerHTML = currentList.map((e) => {
      const code = extractCode(e);
      const snippet = (e.snippet || '').trim();
      const isSelected = selectedId !== null && String(e.id) === String(selectedId);
      const codeChip = code
        ? `<button type="button" class="code-chip" data-copy-code="${escapeHtml(code)}" title="点击复制验证码">${ICONS.key}${escapeHtml(code)}</button>`
        : '';
      return `
        <article class="mail-row${e.is_read ? '' : ' is-unread'}${isSelected ? ' is-selected' : ''}" data-id="${e.id}" role="listitem" tabindex="0" ${isSelected ? 'aria-current="true"' : ''} aria-label="${e.is_read ? '' : '未读邮件：'}${escapeHtml(e.subject || '无主题')}">
          <div class="mail-row-body">
            <div class="mail-row-top">
              <span class="unread-dot" aria-hidden="true"></span>
              <span class="sr-only">${e.is_read ? '已读' : '未读'}</span>
              <span class="mail-sender" title="${escapeHtml(e.from_addr)}">${escapeHtml(e.from_addr)}</span>
              <time class="mail-time" title="${escapeHtml(fullTime(e.created_at))}">${escapeHtml(relTime(e.created_at))}</time>
            </div>
            <div class="mail-row-subject">
              <span class="subject-text">${escapeHtml(e.subject || '（无主题）')}</span>
              ${codeChip}
            </div>
            <div class="mail-row-bottom">
              <span class="mail-prefix-tag" title="收件地址：${escapeHtml(e.to_addr)}">${escapeHtml(e.to_prefix)}</span>
              ${snippet ? `<span class="mail-row-snippet">${escapeHtml(snippet)}</span>` : ''}
            </div>
          </div>
          <div class="mail-row-actions">
            <button type="button" class="icon-btn danger" data-del="${e.id}" title="删除邮件" aria-label="删除邮件">${ICONS.trash}</button>
          </div>
        </article>`;
    }).join('');

    const totalPages = Math.max(1, Math.ceil(total / limit));
    $('#emails-pagination').hidden = totalPages <= 1;
    $('#page-info').textContent = `${cur} / ${totalPages}`;
    $('#page-prev').disabled = cur <= 1;
    $('#page-next').disabled = cur >= totalPages;

    if (selectedId !== null && !byId.has(String(selectedId))) {
      clearSelection();
    }
  }

  function renderDetail(email) {
    disposeReader();
    const container = readerEl();
    const deliveryPane = deliveryEl();
    if (!container || !deliveryPane) return;

    const code = extractCode(email);
    const sender = senderIdentity(email.from_addr);
    const hasHtml = Boolean(email.html_body);
    const hasRaw = Boolean(email.raw_body);
    let blockRemote = readBlockRemotePref();
    let preview = hasHtml ? buildEmailPreviewDocument(email.html_body, { allowRemote: !blockRemote }) : null;
    const readablePlainText = (email.text_body && !looksCssPolluted(email.text_body))
      ? email.text_body
      : (preview?.plainText || email.text_body || '（正文为空）');

    let activeFormat = hasHtml ? 'html' : 'text';

    const formatSwitch = `
      <div class="body-format-switch reader-format-switch" role="tablist" aria-label="正文格式">
        ${hasHtml ? '<button type="button" class="format-tab active" data-format="html" role="tab" aria-selected="true">HTML</button>' : ''}
        <button type="button" class="format-tab ${hasHtml ? '' : 'active'}" data-format="text" role="tab" aria-selected="${hasHtml ? 'false' : 'true'}">纯文本</button>
        <button type="button" class="format-tab" data-format="raw" role="tab" aria-selected="false">Raw</button>
      </div>`;

    const remoteBtnHtml = (hasHtml && preview?.hasExternalContent) ? `
      <button type="button" class="icon-btn reader-remote-btn${blockRemote ? ' is-blocked' : ''}" data-act="toggle-remote"
        title="${blockRemote ? '当前已屏蔽外部图片与样式，点击加载' : (preview.strippedTrackers ? `已加载外部内容，并自动拦截 ${preview.strippedTrackers} 个追踪像素；点击可切换屏蔽外链` : '已加载外部图片与样式，点击可切换屏蔽外链')}"
        aria-label="切换外部图片与样式加载">
        ${ICONS.shield}
      </button>` : '';

    container.innerHTML = `
      <div class="reader-bar">
        <div class="reader-bar-top">
          <button type="button" class="btn btn-sm btn-ghost reader-back-btn" data-act="back-list">
            ${ICONS.chevronLeft}<span>收件箱</span>
          </button>
          <div class="reader-bar-actions">
            <button type="button" class="btn btn-sm reader-reply-btn" data-act="reply" title="回复邮件">
              ${ICONS.reply}<span>回复</span>
            </button>
            <button type="button" class="icon-btn" data-act="copy-body" title="复制正文" aria-label="复制正文">${ICONS.copy}</button>
            <button type="button" class="icon-btn danger" data-act="delete" title="删除邮件" aria-label="删除邮件">${ICONS.trash}</button>
            <button type="button" class="btn btn-sm reader-drawer-toggle${deliveryOpen ? ' active' : ''}" data-act="toggle-drawer" aria-expanded="${deliveryOpen}">
              <span class="drawer-status-dot" data-drawer-dot hidden></span>
              <span>投递</span>
              <span class="drawer-count" data-downstream-count hidden>0</span>
            </button>
          </div>
        </div>
        <div class="reader-bar-sub">
          ${formatSwitch}
          <div class="reader-bar-tools">
            ${code ? `
            <button type="button" class="code-chip reader-code-pill" data-act="copy-code" title="点击复制验证码">
              ${ICONS.key}<span>${escapeHtml(code)}</span>
            </button>` : ''}
            ${remoteBtnHtml}
          </div>
        </div>
      </div>

      <div class="reader-content">
        <header class="reader-mail-header">
          <h2 class="reader-subject">${escapeHtml(email.subject || '（无主题）')}</h2>
          <div class="reader-sender-row">
            <span class="mail-avatar tone-${sender.tone}" aria-hidden="true">${escapeHtml(sender.initial)}</span>
            <div class="reader-sender-meta">
              <div class="reader-sender-primary">
                <strong title="${escapeHtml(email.from_addr)}">${escapeHtml(email.from_addr)}</strong>
                <time title="${escapeHtml(fullTime(email.created_at))}">${escapeHtml(fullTime(email.created_at))}</time>
              </div>
              <div class="reader-sender-secondary">
                <span>发送至 ${escapeHtml(email.to_addr)}</span>
              </div>
            </div>
          </div>
        </header>

        ${email.body_truncated ? `
        <div class="body-warning reader-inline-warning" role="status">
          ${ICONS.alert}<span>正文超过存储上限，以下内容已截断。</span>
        </div>` : ''}

        <div class="reader-surface">
          ${hasHtml ? `
          <div class="reader-html-wrap" data-format-panel="html">
            <iframe
              class="email-preview-frame"
              data-email-preview
              title="HTML 邮件正文"
              sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
              referrerpolicy="no-referrer"
            ></iframe>
          </div>` : ''}
          <div class="detail-body email-plain-body" data-format-panel="text" ${hasHtml ? 'hidden' : ''}>${escapeHtml(readablePlainText)}</div>
          <div class="email-raw-panel" data-format-panel="raw" hidden>
            ${email.raw_truncated ? `
            <div class="body-warning" role="status">
              ${ICONS.alert}<span>Raw 源码超过 256 KiB，以下内容已截断。</span>
            </div>` : ''}
            ${hasRaw
              ? `<pre class="email-raw-body">${escapeHtml(email.raw_body)}</pre>`
              : `<div class="raw-unavailable">${ICONS.alert}<span>此历史邮件未保存原始源码；新收到的邮件会自动保留 Raw。</span></div>`}
          </div>
        </div>
      </div>
    `;

    deliveryPane.innerHTML = `
      <div class="drawer-head">
        <strong>投递与操作</strong>
        <button type="button" class="icon-btn" data-act="close-drawer" title="收起侧栏" aria-label="收起侧栏">${ICONS.close}</button>
      </div>
      <div class="drawer-scroll">
        ${code ? `
        <div class="sidebar-section">
          <div class="sidebar-section-head"><h3>验证码</h3></div>
          <div class="code-banner">
            <span class="code-banner-icon">${ICONS.key}</span>
            <span class="code-value">${escapeHtml(code)}</span>
            <button type="button" class="btn btn-sm" data-act="copy-code">${ICONS.copy} 复制</button>
          </div>
        </div>` : ''}

        <div class="sidebar-section">
          <div class="sidebar-section-head">
            <h3>投递记录</h3>
            <span class="downstream-refresh-label" data-downstream-updated>同步中</span>
          </div>
          <div class="downstream-list" data-downstream-list aria-live="polite">
            <div class="downstream-loading"><span class="spinner" aria-hidden="true"></span>正在读取投递记录…</div>
          </div>
        </div>

        <div class="sidebar-section sidebar-divider" data-reply-section hidden>
          <div class="sidebar-section-head">
            <h3>回复记录</h3>
            <span class="downstream-refresh-label" data-reply-count></span>
          </div>
          <div class="downstream-list" data-reply-list aria-live="polite"></div>
        </div>

        <div class="sidebar-section sidebar-divider">
          <div class="sidebar-section-head"><h3>快捷操作</h3></div>
          <div class="dispatch-picker" role="group" aria-label="选择邮件操作">
            <button type="button" class="dispatch-btn" data-act="reply">
              <span class="dispatch-btn-icon channel-reply">${ICONS.reply}</span>
              <span>回复邮件</span>
            </button>
            <button type="button" class="dispatch-btn" data-act="forward" aria-expanded="false">
              <span class="dispatch-btn-icon channel-forward">${ICONS.mail}</span>
              <span>转发邮箱</span>
            </button>
            <button type="button" class="dispatch-btn" data-act="telegram" aria-expanded="false">
              <span class="dispatch-btn-icon channel-telegram">${ICONS.send}</span>
              <span>Telegram</span>
            </button>
            <button type="button" class="dispatch-btn" data-act="bark" aria-expanded="false">
              <span class="dispatch-btn-icon channel-bark">B</span>
              <span>Bark</span>
            </button>
          </div>

          <form class="dispatch-editor" data-forward-form hidden novalidate>
            <div class="quick-downstream-heading">
              <div>
                <strong>转发到邮箱</strong>
                <span>使用已保存的正文，不包含原邮件附件。</span>
              </div>
              <button type="button" class="icon-btn" data-act="cancel-forward" title="取消" aria-label="取消转发">${ICONS.close}</button>
            </div>
            <div class="quick-downstream-row">
              <input name="to" type="email" maxlength="254" placeholder="recipient@example.com" autocomplete="email" required aria-label="转发收件邮箱">
              <button type="submit" class="btn btn-primary btn-sm">
                <span class="spinner hidden" aria-hidden="true"></span>
                <span data-forward-label>发送</span>
              </button>
            </div>
            <div class="downstream-create-error" data-forward-error role="alert" hidden></div>
          </form>

          <form class="dispatch-editor dispatch-telegram" data-telegram-form hidden novalidate>
            <div class="quick-downstream-heading">
              <div>
                <strong>推送到 Telegram</strong>
                <span>行为与自动推送一致，包含精简摘要与验证码识别结果。</span>
              </div>
              <button type="button" class="icon-btn" data-act="cancel-telegram" title="取消" aria-label="取消 Telegram 推送">${ICONS.close}</button>
            </div>
            <div class="dispatch-stack-fields">
              <label class="field">
                <span class="field-label">发送 Bot</span>
                <select name="bot_id" required aria-label="发送 Bot">${telegramBotOptions()}</select>
              </label>
              <label class="field">
                <span class="field-label">Chat ID</span>
                <input name="chat_id" type="text" placeholder="-1001234567890" autocomplete="off" spellcheck="false" required aria-label="Telegram Chat ID">
              </label>
              <button type="submit" class="btn btn-primary btn-sm btn-block">
                <span class="spinner hidden" aria-hidden="true"></span>
                <span data-telegram-label>推送</span>
              </button>
            </div>
            <div class="downstream-create-error" data-telegram-error role="alert" hidden></div>
          </form>

          <form class="dispatch-editor dispatch-bark" data-bark-form hidden novalidate>
            <div class="quick-downstream-heading">
              <div>
                <strong>推送到 Bark</strong>
                <span>包含邮件摘要与验证码识别结果。</span>
              </div>
              <button type="button" class="icon-btn" data-act="cancel-bark" title="取消" aria-label="取消 Bark 推送">${ICONS.close}</button>
            </div>
            <div class="dispatch-stack-fields">
              <label class="field">
                <span class="field-label">Bark 目标</span>
                <select name="endpoint_id" required>${barkEndpointOptions()}</select>
              </label>
              <button type="submit" class="btn btn-primary btn-sm btn-block">
                <span class="spinner hidden" aria-hidden="true"></span>
                <span data-bark-label>推送</span>
              </button>
            </div>
            <div class="downstream-create-error" data-bark-error role="alert" hidden></div>
          </form>
        </div>

        <div class="sidebar-section sidebar-divider">
          <div class="sidebar-section-head"><h3>邮件信息</h3></div>
          <dl class="reader-meta-drawer">
            <dt>发件人</dt><dd>${escapeHtml(email.from_addr)}</dd>
            ${email.envelope_from && email.envelope_from !== email.from_addr ? `<dt>信封</dt><dd title="SMTP 信封发件人（退信地址）">${escapeHtml(email.envelope_from)}</dd>` : ''}
            <dt>收件人</dt><dd>${escapeHtml(email.to_addr)}</dd>
            <dt>前缀</dt><dd>${escapeHtml(email.to_prefix)}</dd>
            <dt>时间</dt><dd>${escapeHtml(fullTime(email.created_at))}</dd>
          </dl>
        </div>
      </div>
    `;

    container.querySelector('[data-act="back-list"]').addEventListener('click', clearSelection);

    const copyBtn = container.querySelector('[data-act="copy-body"]');
    copyBtn.addEventListener('click', () => {
      if (activeFormat === 'raw') {
        copyText(email.raw_body || '', 'Raw');
        return;
      }
      copyText(readablePlainText, '正文');
    });

    for (const root of [container, deliveryPane]) {
      root.querySelectorAll('[data-act="copy-code"]').forEach((btn) => {
        btn.addEventListener('click', () => copyText(code, '验证码'));
      });
    }

    container.querySelector('[data-act="delete"]').addEventListener('click', () => remove(email));

    const drawerToggle = container.querySelector('[data-act="toggle-drawer"]');
    function setDeliveryOpen(next) {
      deliveryOpen = next;
      deliveryPane.hidden = !next;
      shellEl()?.classList.toggle('has-delivery', next);
      drawerToggle.classList.toggle('active', next);
      drawerToggle.setAttribute('aria-expanded', String(next));
      if (activeFormat === 'html') requestAnimationFrame(layoutPreview);
    }
    setDeliveryOpen(deliveryOpen);
    drawerToggle.addEventListener('click', () => {
      const next = !deliveryOpen;
      setDeliveryOpen(next);
      if (next && window.matchMedia('(max-width: 860px)').matches) {
        requestAnimationFrame(() => {
          deliveryPane.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        });
      }
    });
    deliveryPane.querySelector('[data-act="close-drawer"]').addEventListener('click', () => setDeliveryOpen(false));

    // The frame is same-origin (sandbox allow-same-origin) only so the parent can measure
    // the email and size/fit it cleanly. That is safe solely because scripts stay
    // disabled: never add allow-scripts to that sandbox, or email content could reach
    // the console's session.
    const previewFrame = container.querySelector('[data-email-preview]');
    function layoutPreview() {
      if (!previewFrame || !previewFrame.isConnected) return;
      fitPreviewFrame(previewFrame);
    }
    if (previewFrame && preview) {
      previewFrame.addEventListener('load', () => {
        layoutPreview();
        observePreviewImages(previewFrame, layoutPreview);
      });
      previewFrame.srcdoc = preview.srcdoc;
      window.addEventListener('resize', layoutPreview);
    }

    const remoteToggle = container.querySelector('[data-act="toggle-remote"]');
    if (remoteToggle && previewFrame) {
      remoteToggle.addEventListener('click', () => {
        blockRemote = !blockRemote;
        writeBlockRemotePref(blockRemote);
        preview = buildEmailPreviewDocument(email.html_body, { allowRemote: !blockRemote });
        previewFrame.srcdoc = preview.srcdoc;
        remoteToggle.classList.toggle('is-blocked', blockRemote);
        remoteToggle.title = blockRemote
          ? '当前已屏蔽外部图片与样式，点击加载'
          : (preview.strippedTrackers
            ? `已加载外部内容，并自动拦截 ${preview.strippedTrackers} 个追踪像素；点击可切换屏蔽外链`
            : '已加载外部图片与样式，点击可切换屏蔽外链');
        toast(blockRemote ? '已屏蔽外部图片与样式' : '已加载外部图片与样式', 'info');
      });
    }

    container.querySelectorAll('[data-format]').forEach((button) => {
      button.addEventListener('click', () => {
        const format = button.dataset.format;
        activeFormat = format;
        container.querySelectorAll('[data-format]').forEach((tab) => {
          const active = tab.dataset.format === format;
          tab.classList.toggle('active', active);
          tab.setAttribute('aria-selected', String(active));
        });
        container.querySelectorAll('[data-format-panel]').forEach((panel) => {
          panel.hidden = panel.dataset.formatPanel !== format;
        });
        const copyLabel = format === 'raw' ? '复制 Raw' : '复制正文';
        copyBtn.title = copyLabel;
        copyBtn.setAttribute('aria-label', copyLabel);
        copyBtn.disabled = format === 'raw' && !hasRaw;
        if (remoteToggle) remoteToggle.hidden = format !== 'html';
        if (format === 'html') layoutPreview();
      });
    });

    const downstreamList = deliveryPane.querySelector('[data-downstream-list]');
    const downstreamCount = container.querySelector('[data-downstream-count]');
    const drawerDot = container.querySelector('[data-drawer-dot]');
    const downstreamUpdated = deliveryPane.querySelector('[data-downstream-updated]');
    const replySection = deliveryPane.querySelector('[data-reply-section]');
    const replyList = deliveryPane.querySelector('[data-reply-list]');
    const replyCount = deliveryPane.querySelector('[data-reply-count]');
    let replies = Array.isArray(email.replies) ? [...email.replies] : [];

    function renderReplies() {
      replySection.hidden = replies.length === 0;
      if (!replies.length) {
        replyList.innerHTML = '';
        return;
      }
      replyCount.textContent = `${replies.length} 条`;
      replyList.innerHTML = replies.map((item) => {
        const failed = item.status === 'failed';
        const statusLabel = failed ? '失败' : '已发送';
        const snippet = String(item.text_body || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        return `
          <article class="delivery-card node-${failed ? 'failed' : 'success'}" data-sent-id="${item.id}">
            <div class="delivery-card-head">
              <span class="delivery-channel-icon channel-reply">${ICONS.reply}</span>
              <div class="delivery-card-info">
                <span class="delivery-card-channel">从 ${escapeHtml(item.from_addr)}</span>
                <strong class="downstream-target mono" title="${escapeHtml(item.to_addr)}">${escapeHtml(item.to_addr)}</strong>
              </div>
              <span class="downstream-status status-${failed ? 'failed' : 'success'}"><i></i>${statusLabel}</span>
            </div>
            ${snippet ? `<div class="reply-card-snippet">${escapeHtml(snippet)}</div>` : ''}
            ${item.error ? `<div class="downstream-error">${escapeHtml(item.error)}</div>` : ''}
            <div class="delivery-card-foot">
              <span class="delivery-card-meta"><time title="${escapeHtml(fullTime(item.created_at))}">${escapeHtml(relTime(item.created_at))}</time></span>
            </div>
          </article>`;
      }).join('');
    }
    renderReplies();
    let downstreamSeq = 0;
    let downstreamLoading = false;
    let downstreamState = { tracked: false, data: [] };
    let confirmingDownstreamId = null;
    let downstreamFingerprint = '';
    let active = true;

    function renderDownstreams(result) {
      downstreamState = result;
      downstreamFingerprint = JSON.stringify(result);
      downstreamCount.textContent = String(result.data.length);
      downstreamCount.hidden = result.data.length === 0;

      if (result.data.length > 0) {
        const hasFailure = result.data.some((item) => item.status === 'failed' || (item.status === 'pending' && item.is_stale));
        const hasPending = result.data.some((item) => item.status === 'pending' && !item.is_stale);
        drawerDot.hidden = false;
        drawerDot.className = `drawer-status-dot is-${hasFailure ? 'failed' : hasPending ? 'pending' : 'success'}`;
      } else {
        drawerDot.hidden = true;
      }

      const legacyHint = result.tracked ? '' : `
        <div class="downstream-legacy">这封邮件没有完整的自动下游记录：可能接收于功能上线前，或记录阶段发生过异常。</div>`;

      if (!result.data.length) {
        downstreamList.innerHTML = `${legacyHint}
          <div class="downstream-empty">
            ${result.tracked ? '未命中任何启用的自动投递规则' : '暂无投递记录'}
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
          ? (item.channel === 'forward' ? '手动转发' : '手动推送')
          : '自动规则';
        const botLabel = item.channel === 'telegram' && item.telegram_bot_name
          ? ` · ${item.telegram_bot_name}`
          : '';
        const isConfirming = confirmingDownstreamId === String(item.id);
        const retryAction = isConfirming ? `
          <div class="downstream-confirm" role="group" aria-label="确认再次触发">
            <span>确定再次触发？</span>
            <button type="button" class="btn btn-sm" data-cancel-retry="${item.id}">取消</button>
            <button type="button" class="btn btn-primary btn-sm" data-confirm-retry="${item.id}">确认</button>
          </div>` : `
          <button type="button" class="btn btn-sm" data-retry-downstream="${item.id}"
            ${item.status === 'pending' && !stale ? 'disabled' : ''}>${ICONS.forward} 再次触发</button>`;

        const channelIcon = item.channel === 'bark' ? 'B' : item.channel === 'telegram' ? ICONS.send : ICONS.mail;
        return `
          <article class="delivery-card node-${visibleStatus}" data-downstream-id="${item.id}">
            <div class="delivery-card-head">
              <span class="delivery-channel-icon channel-${item.channel}">${channelIcon}</span>
              <div class="delivery-card-info">
                <span class="delivery-card-channel">${escapeHtml(channelLabel)}${escapeHtml(botLabel)} · ${escapeHtml(sourceLabel)}</span>
                <strong class="downstream-target mono" title="${escapeHtml(item.target)}">${escapeHtml(item.target)}</strong>
              </div>
              <span class="downstream-status status-${visibleStatus}"><i></i>${escapeHtml(statusLabel)}</span>
            </div>
            ${item.last_error ? `<div class="downstream-error">${escapeHtml(item.last_error)}</div>` : ''}
            <div class="delivery-card-foot">
              <span class="delivery-card-meta">第 ${item.attempt_count} 次 · <time title="${escapeHtml(fullTime(item.last_triggered_at))}">${escapeHtml(relTime(item.last_triggered_at))}</time></span>
              <div class="delivery-card-action">${retryAction}</div>
            </div>
          </article>`;
      }).join('');
    }

    async function loadDownstreams({ quiet = false } = {}) {
      if (!active || downstreamLoading) return;
      downstreamLoading = true;
      const my = ++downstreamSeq;
      if (!quiet && !downstreamState.data.length) {
        downstreamList.innerHTML = '<div class="downstream-loading"><span class="spinner" aria-hidden="true"></span>正在读取投递记录…</div>';
      }
      try {
        const result = await api(`/emails/${email.id}/downstreams`);
        if (!active || my !== downstreamSeq) return;
        const nextFingerprint = JSON.stringify(result);
        if (nextFingerprint !== downstreamFingerprint) renderDownstreams(result);
        downstreamUpdated.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      } catch (error) {
        if (!active || my !== downstreamSeq || error.status === 401) return;
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
    const downstreamTimer = setInterval(() => {
      if (!active || $('#tab-emails')?.hidden) return;
      void loadDownstreams({ quiet: true });
    }, 5000);

    const forwardForm = deliveryPane.querySelector('[data-forward-form]');
    const forwardTrigger = deliveryPane.querySelector('[data-act="forward"]');
    const forwardInput = forwardForm.querySelector('input[name="to"]');
    const forwardError = deliveryPane.querySelector('[data-forward-error]');
    const telegramForm = deliveryPane.querySelector('[data-telegram-form]');
    const telegramTrigger = deliveryPane.querySelector('[data-act="telegram"]');
    const telegramSelect = telegramForm.querySelector('select[name="bot_id"]');
    const telegramChatInput = telegramForm.querySelector('input[name="chat_id"]');
    const telegramError = telegramForm.querySelector('[data-telegram-error]');
    const barkForm = deliveryPane.querySelector('[data-bark-form]');
    const barkTrigger = deliveryPane.querySelector('[data-act="bark"]');
    const barkSelect = barkForm.querySelector('select[name="endpoint_id"]');
    const barkError = barkForm.querySelector('[data-bark-error]');

    function closeAllDispatches() {
      for (const [form, trigger, errorEl] of [
        [forwardForm, forwardTrigger, forwardError],
        [telegramForm, telegramTrigger, telegramError],
        [barkForm, barkTrigger, barkError],
      ]) {
        form.hidden = true;
        trigger.classList.remove('active');
        trigger.setAttribute('aria-expanded', 'false');
        errorEl.hidden = true;
      }
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

    const openReply = () => {
      closeAllDispatches();
      openComposeModal({
        initialPrefix: email.to_prefix || '',
        initialTo: email.reply_to_addr || email.from_addr || '',
        initialSubject: replySubject(email.subject),
        initialText: buildReplyQuote(email, readablePlainText),
        replyToEmail: email,
        onSent: (sent) => {
          if (!sent || !active) return;
          replies = [sent, ...replies];
          renderReplies();
        },
      });
    };
    for (const root of [container, deliveryPane]) {
      root.querySelectorAll('[data-act="reply"]').forEach((btn) => {
        btn.addEventListener('click', openReply);
      });
    }

    forwardTrigger.addEventListener('click', () => {
      const alreadyOpen = !forwardForm.hidden;
      closeAllDispatches();
      if (alreadyOpen) return;
      forwardForm.hidden = false;
      forwardTrigger.classList.add('active');
      forwardTrigger.setAttribute('aria-expanded', 'true');
      forwardInput.focus();
    });
    deliveryPane.querySelector('[data-act="cancel-forward"]').addEventListener('click', closeAllDispatches);
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
        closeAllDispatches();
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
            <small>请确认「设置 → 邮件发送」已完成配置且发件域名已验证。</small>`;
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
      const alreadyOpen = !telegramForm.hidden;
      closeAllDispatches();
      if (alreadyOpen) return;
      telegramForm.hidden = false;
      telegramTrigger.classList.add('active');
      telegramTrigger.setAttribute('aria-expanded', 'true');
      await refreshQuickTelegramBots();
      if (!telegramForm.hidden && !telegramSelect.disabled) {
        telegramSelect.focus();
      }
    });
    deliveryPane.querySelector('[data-act="cancel-telegram"]').addEventListener('click', closeAllDispatches);
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
        closeAllDispatches();
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
      const alreadyOpen = !barkForm.hidden;
      closeAllDispatches();
      if (alreadyOpen) return;
      barkForm.hidden = false;
      barkTrigger.classList.add('active');
      barkTrigger.setAttribute('aria-expanded', 'true');
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
    deliveryPane.querySelector('[data-act="cancel-bark"]').addEventListener('click', closeAllDispatches);
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
        closeAllDispatches();
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

    cleanupReader = () => {
      active = false;
      clearInterval(downstreamTimer);
      window.removeEventListener('resize', layoutPreview);
    };
  }

  function openDetail(summary) {
    const my = ++detailSeq;
    disposeReader();
    selectedId = String(summary.id);
    shellEl()?.classList.add('has-selection');
    syncSelectedRowHighlight();
    if (window.matchMedia('(max-width: 860px)').matches) {
      window.scrollTo?.({ top: 0, behavior: 'instant' });
    }

    const container = readerEl();
    container.innerHTML = `
      <div class="reader-bar">
        <div class="reader-bar-top">
          <button type="button" class="btn btn-sm btn-ghost reader-back-btn" data-act="back-list">
            ${ICONS.chevronLeft}<span>收件箱</span>
          </button>
        </div>
      </div>
      <div class="detail-loading" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <span>正在加载邮件正文…</span>
      </div>`;
    container.querySelector('[data-act="back-list"]')?.addEventListener('click', clearSelection);

    async function loadDetail() {
      try {
        const email = await api(`/emails/${summary.id}`);
        if (my !== detailSeq) return;
        renderDetail(email);
        if (!summary.is_read) {
          try {
            const result = await api(`/emails/${summary.id}/read`, { method: 'PATCH' });
            summary.is_read = true;
            const row = listEl().querySelector(`.mail-row[data-id="${summary.id}"]`);
            if (row) {
              row.classList.remove('is-unread');
              row.setAttribute('aria-label', summary.subject || '无主题');
              const state = row.querySelector('.sr-only');
              if (state) state.textContent = '已读';
            }
            renderUnreadCount(result.unread_count);
          } catch (error) {
            if (error.status !== 401) {
              console.error('Failed to mark email as read', error);
            }
          }
        }
      } catch (err) {
        if (my !== detailSeq || err.status === 401) return;
        container.innerHTML = `
          <div class="reader-bar">
            <div class="reader-bar-top">
              <button type="button" class="btn btn-sm btn-ghost reader-back-btn" data-act="back-list">
                ${ICONS.chevronLeft}<span>收件箱</span>
              </button>
            </div>
          </div>
          <div class="detail-error">${errorStateHtml(err.message)}</div>`;
        container.querySelector('[data-act="back-list"]')?.addEventListener('click', clearSelection);
        container.querySelector('[data-retry]')?.addEventListener('click', () => openDetail(summary));
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
      if (String(email.id) === selectedId) clearSelection();
      load();
    } catch (err) {
      if (err.status !== 401) toast(`删除失败：${err.message}`, 'error');
    }
  }

  function openComposeModal({
    initialPrefix = '',
    initialTo = '',
    initialSubject = '',
    initialText = '',
    replyToEmail = null,
    onSent = null,
  } = {}) {
    const isReply = Boolean(replyToEmail);
    const fixedReceiveDomain = replyToEmail ? emailDomain(replyToEmail.to_addr) : '';
    const overlay = openModal(`
      <form class="compose-email-form" novalidate>
        <div class="modal-header">
          <div class="modal-heading">
            <h3 class="modal-title">${isReply ? '回复邮件' : '写邮件'}</h3>
            <p class="modal-subtitle">${isReply
              ? `回复来自 ${escapeHtml(replyToEmail.reply_to_addr || replyToEmail.from_addr)} 的邮件`
              : '使用已验证发信域名下的任意前缀向外发送纯文本邮件'}</p>
          </div>
          <button type="button" class="icon-btn" data-act="close" title="关闭" aria-label="关闭">${ICONS.close}</button>
        </div>
        <div class="modal-body compose-modal-body">
          <div class="compose-warning" data-compose-warning hidden>
            <span data-compose-warning-text></span>
            <button type="button" class="btn btn-sm" data-act="goto-settings">前往设置</button>
          </div>
          <div class="field compose-prefix-field">
            <label class="field-label" for="compose-prefix">发件前缀</label>
            <div class="compose-prefix-anchor">
              <div class="compose-prefix-control">
                <input id="compose-prefix" name="prefix" type="text" maxlength="64"
                  value="${escapeHtml(initialPrefix)}" placeholder="输入或选择前缀，如 hi、github"
                  autocomplete="off" spellcheck="false" role="combobox"
                  aria-expanded="false" aria-autocomplete="list" aria-controls="compose-prefix-menu" required>
                <span class="compose-prefix-domain mono" data-compose-domain hidden></span>
                <button type="button" class="icon-btn compose-prefix-toggle" data-compose-prefix-toggle
                  title="选择常用前缀" aria-label="展开常用前缀" hidden>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
                </button>
              </div>
              <div id="compose-prefix-menu" class="compose-prefix-menu" role="listbox" data-compose-menu hidden></div>
            </div>
            <small class="field-help compose-address-preview" data-compose-preview>正在读取发信配置…</small>
          </div>
          <div class="field">
            <label class="field-label" for="compose-to">收件人</label>
            <input id="compose-to" name="to" type="email" maxlength="254"
              value="${escapeHtml(initialTo)}" placeholder="recipient@example.com"
              autocomplete="email" required>
          </div>
          <div class="field">
            <label class="field-label" for="compose-subject">主题</label>
            <input id="compose-subject" name="subject" type="text" maxlength="998"
              value="${escapeHtml(initialSubject)}" placeholder="邮件主题" autocomplete="off" required>
          </div>
          <div class="field">
            <label class="field-label" for="compose-text">正文</label>
            <textarea id="compose-text" name="text" class="compose-textarea" rows="8"
              placeholder="输入邮件正文（纯文本）" required></textarea>
          </div>
          <div class="downstream-create-error" data-compose-error role="alert" hidden></div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" data-act="close">取消</button>
          <button type="submit" class="btn btn-primary" data-compose-submit>
            <span class="spinner hidden" aria-hidden="true"></span>
            <span data-compose-label>发送</span>
          </button>
        </div>
      </form>
    `);

    const form = overlay.querySelector('.compose-email-form');
    const prefixInput = form.querySelector('#compose-prefix');
    const prefixDomainEl = form.querySelector('[data-compose-domain]');
    const prefixToggleBtn = form.querySelector('[data-compose-prefix-toggle]');
    const prefixMenuEl = form.querySelector('[data-compose-menu]');
    const toInput = form.querySelector('#compose-to');
    const subjectInput = form.querySelector('#compose-subject');
    const textInput = form.querySelector('#compose-text');
    const previewEl = form.querySelector('[data-compose-preview]');
    const warningEl = form.querySelector('[data-compose-warning]');
    const warningTextEl = form.querySelector('[data-compose-warning-text]');
    const errorEl = form.querySelector('[data-compose-error]');
    const submitBtn = form.querySelector('[data-compose-submit]');
    const spinnerEl = submitBtn.querySelector('.spinner');
    const labelEl = submitBtn.querySelector('[data-compose-label]');

    textInput.value = initialText;

    let closed = false;
    let menuOpen = false;
    let activeIndex = -1;
    let filteredPrefixes = [];
    let context = {
      loaded: false,
      configured: true,
      send_domain: '',
      receive_domain: fixedReceiveDomain,
      prefixes: [],
    };

    overlay.addEventListener('modal-closed', () => { closed = true; });
    overlay.querySelectorAll('[data-act="close"]').forEach((btn) => {
      btn.addEventListener('click', closeModal);
    });
    overlay.querySelector('[data-act="goto-settings"]').addEventListener('click', () => {
      closeModal();
      switchTab('settings');
    });

    function resolvedSendDomain() {
      const receiveDomain = fixedReceiveDomain || context.receive_domain || '';
      return context.send_domain || receiveDomain;
    }

    function updatePreview() {
      const normalized = prefixInput.value.trim().toLowerCase();
      const receiveDomain = fixedReceiveDomain || context.receive_domain || '';
      const sendDomain = resolvedSendDomain();
      prefixDomainEl.textContent = sendDomain ? `@${sendDomain}` : '';
      prefixDomainEl.hidden = !sendDomain;

      if (!context.loaded) {
        previewEl.textContent = '正在读取发信配置…';
        return;
      }
      if (!sendDomain) {
        previewEl.textContent = '尚未确定发件域名，请先在「设置 → 邮件发送」中配置发件地址。';
        return;
      }
      if (!normalized) {
        if (receiveDomain && receiveDomain !== sendDomain) {
          previewEl.innerHTML = `可自由输入任意前缀；跨域发信时将自动附带 <code>Reply-To: 前缀@${escapeHtml(receiveDomain)}</code>`;
        } else {
          previewEl.textContent = '可自由输入任意新前缀，或点右侧箭头选择常用前缀。';
        }
        return;
      }
      const fromAddr = `${normalized}@${sendDomain}`;
      const fromDisplay = `${normalized} <${fromAddr}>`;
      if (receiveDomain && receiveDomain !== sendDomain) {
        previewEl.innerHTML = `发件人 <code>${escapeHtml(fromDisplay)}</code> · 对方回复将进入 <code>${escapeHtml(`${normalized}@${receiveDomain}`)}</code>`;
      } else {
        previewEl.innerHTML = `发件人 <code>${escapeHtml(fromDisplay)}</code>`;
      }
    }

    function closePrefixMenu() {
      if (!menuOpen) return;
      menuOpen = false;
      activeIndex = -1;
      prefixMenuEl.hidden = true;
      prefixInput.setAttribute('aria-expanded', 'false');
      prefixToggleBtn.classList.remove('is-open');
    }

    function renderPrefixMenu({ showAll = false } = {}) {
      if (!context.prefixes.length) {
        closePrefixMenu();
        return;
      }
      const query = showAll ? '' : prefixInput.value.trim().toLowerCase();
      const starts = [];
      const contains = [];
      for (const item of context.prefixes) {
        if (!query || item.startsWith(query)) starts.push(item);
        else if (item.includes(query)) contains.push(item);
      }
      filteredPrefixes = [...starts, ...contains];
      if (!filteredPrefixes.length) {
        closePrefixMenu();
        return;
      }
      if (activeIndex >= filteredPrefixes.length) activeIndex = 0;
      const domain = resolvedSendDomain();
      const current = prefixInput.value.trim().toLowerCase();
      prefixMenuEl.innerHTML = filteredPrefixes.map((item, idx) => `
        <button type="button" class="compose-prefix-option${idx === activeIndex ? ' is-active' : ''}${item === current ? ' is-selected' : ''}"
          role="option" aria-selected="${item === current}" data-prefix-option="${escapeHtml(item)}" data-prefix-index="${idx}">
          <span class="compose-prefix-opt-name mono">${escapeHtml(item)}</span>
          ${domain ? `<span class="compose-prefix-opt-domain mono">@${escapeHtml(domain)}</span>` : ''}
        </button>
      `).join('');
      menuOpen = true;
      prefixMenuEl.hidden = false;
      prefixInput.setAttribute('aria-expanded', 'true');
      prefixToggleBtn.classList.add('is-open');
    }

    function selectPrefixOption(value) {
      prefixInput.value = value;
      updatePreview();
      closePrefixMenu();
      prefixInput.focus();
    }

    prefixInput.addEventListener('input', () => {
      activeIndex = -1;
      updatePreview();
      if (context.prefixes.length) renderPrefixMenu();
    });
    prefixInput.addEventListener('focus', () => {
      if (context.prefixes.length && !prefixInput.value.trim()) {
        renderPrefixMenu({ showAll: true });
      }
    });
    prefixInput.addEventListener('keydown', (event) => {
      if (!menuOpen) {
        if (event.key === 'ArrowDown' && context.prefixes.length) {
          event.preventDefault();
          activeIndex = 0;
          renderPrefixMenu();
        }
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        activeIndex = (activeIndex + 1) % filteredPrefixes.length;
        renderPrefixMenu();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        activeIndex = activeIndex <= 0 ? filteredPrefixes.length - 1 : activeIndex - 1;
        renderPrefixMenu();
      } else if (event.key === 'Enter' && activeIndex >= 0 && filteredPrefixes[activeIndex]) {
        event.preventDefault();
        selectPrefixOption(filteredPrefixes[activeIndex]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePrefixMenu();
      }
    });
    prefixToggleBtn.addEventListener('mousedown', (event) => {
      event.preventDefault();
      if (menuOpen) closePrefixMenu();
      else {
        prefixInput.focus();
        renderPrefixMenu({ showAll: true });
      }
    });
    prefixMenuEl.addEventListener('mousedown', (event) => {
      const option = event.target.closest('[data-prefix-option]');
      if (!option) return;
      event.preventDefault();
      selectPrefixOption(option.dataset.prefixOption);
    });
    form.addEventListener('mousedown', (event) => {
      if (menuOpen && !event.target.closest('.compose-prefix-field')) {
        closePrefixMenu();
      }
    });
    prefixInput.addEventListener('blur', () => {
      setTimeout(() => {
        if (!closed && document.activeElement !== prefixInput) closePrefixMenu();
      }, 120);
    });

    void (async () => {
      try {
        const res = await api('/outbound/context');
        if (closed) return;
        context = {
          loaded: true,
          configured: Boolean(res.configured),
          send_domain: res.send_domain || '',
          receive_domain: fixedReceiveDomain || res.receive_domain || '',
          prefixes: Array.isArray(res.prefixes) ? res.prefixes : [],
        };
        prefixToggleBtn.hidden = context.prefixes.length === 0;
        if (!context.configured) {
          warningTextEl.textContent = '尚未配置邮件发送服务，请先完成设置后再发送。';
          warningEl.hidden = false;
          submitBtn.disabled = true;
        } else if (!context.send_domain) {
          warningTextEl.textContent = '尚未配置发件地址，无法确定发件域名。';
          warningEl.hidden = false;
          submitBtn.disabled = true;
        } else {
          warningEl.hidden = true;
        }
        updatePreview();
      } catch (err) {
        if (closed || err.status === 401) return;
        context.loaded = true;
        previewEl.textContent = `无法读取发信配置：${err.message}`;
      }
    })();

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorEl.hidden = true;

      const sendPrefix = prefixInput.value.trim().toLowerCase();
      const to = toInput.value.trim();
      const subject = subjectInput.value.trim();
      const text = textInput.value;

      if (!sendPrefix) {
        prefixInput.focus();
        errorEl.innerHTML = '<strong>请填写发件前缀</strong>';
        errorEl.hidden = false;
        return;
      }
      if (!to || !toInput.checkValidity()) {
        toInput.reportValidity();
        return;
      }
      if (!subject) {
        subjectInput.focus();
        errorEl.innerHTML = '<strong>请填写邮件主题</strong>';
        errorEl.hidden = false;
        return;
      }
      if (!text.trim()) {
        textInput.focus();
        errorEl.innerHTML = '<strong>请填写邮件正文</strong>';
        errorEl.hidden = false;
        return;
      }

      submitBtn.disabled = true;
      spinnerEl.classList.remove('hidden');
      labelEl.textContent = '发送中…';

      try {
        const res = await api('/outbound/send', {
          method: 'POST',
          body: JSON.stringify({
            prefix: sendPrefix,
            to,
            subject,
            text,
            ...(replyToEmail ? { reply_to_email_id: replyToEmail.id } : {}),
          }),
        });
        closeModal();
        toast(`邮件已从 ${res.from} 发往 ${to}`, 'success');
        if (onSent) onSent(res.sent);
      } catch (error) {
        if (error.status !== 401) {
          const details = error.details?.email;
          const codeLine = details?.code ? `<code>${escapeHtml(details.code)}</code>` : '';
          const description = details?.description || error.message;
          errorEl.innerHTML = `
            <strong>${escapeHtml(error.message)}</strong>
            ${codeLine}
            <span>${escapeHtml(description)}</span>`;
          errorEl.hidden = false;
          if (onSent && error.details?.sent) onSent(error.details.sent);
        }
      } finally {
        if (!closed) {
          submitBtn.disabled = false;
          spinnerEl.classList.add('hidden');
          labelEl.textContent = '发送';
        }
      }
    });

    if (isReply) {
      textInput.focus();
      textInput.setSelectionRange(0, 0);
    } else if (initialPrefix) {
      toInput.focus();
    } else {
      prefixInput.focus();
    }
  }

  function init() {
    $('#emails-compose')?.addEventListener('click', () => {
      openComposeModal({ initialPrefix: prefix });
    });

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

    document.querySelectorAll('[data-inbox-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        const nextUnread = button.dataset.inboxFilter === 'unread';
        if (nextUnread === unreadOnly) return;
        unreadOnly = nextUnread;
        page = 1;
        document.querySelectorAll('[data-inbox-filter]').forEach((tab) => {
          tab.setAttribute('aria-pressed', String((tab.dataset.inboxFilter === 'unread') === unreadOnly));
        });
        load();
      });
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

    listEl().addEventListener('click', (e) => {
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
      const row = e.target.closest('.mail-row[data-id]');
      if (row) {
        const email = byId.get(row.dataset.id);
        if (email) openDetail(email);
      }
    });

    listEl().addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const row = e.target.closest('.mail-row[data-id]');
      if (row && e.target === row) {
        const email = byId.get(row.dataset.id);
        if (email) openDetail(email);
      }
    });

    // Keyboard ↑ / ↓ quick navigation inside the inbox tab
    document.addEventListener('keydown', (e) => {
      if ($('#tab-emails')?.hidden || !currentList.length) return;
      if ($('#modal-root')?.children.length > 0) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const idx = currentList.findIndex((item) => String(item.id) === selectedId);
        const nextIdx = e.key === 'ArrowDown'
          ? (idx < 0 ? 0 : Math.min(currentList.length - 1, idx + 1))
          : (idx <= 0 ? 0 : idx - 1);
        const target = currentList[nextIdx];
        if (target && String(target.id) !== selectedId) {
          openDetail(target);
          listEl().querySelector(`.mail-row[data-id="${target.id}"]`)?.scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'Escape' && selectedId !== null) {
        clearSelection();
      }
    });
  }

  return { load, loadUnreadCount, init, openComposeModal };
})();

export { emailsView };
