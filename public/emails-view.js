import { $, ICONS, api, barkEndpointOptions, barkEndpoints, closeModal, confirmDialog, copyText } from './app.js';
import { debounce, emptyStateHtml, errorStateHtml, escapeHtml, extractCode, fullTime } from './app.js';
import { loadDestinationCatalogs, loadTelegramBotCatalog, openModal, relTime, renderSkeleton } from './app.js';
import { showState, showTable, telegramBotOptions, telegramBots, toast } from './app.js';
import { buildEmailPreviewDocument } from './email-preview.js';

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

  function render({ data, total, unread_count: unreadCount, page: cur, limit }) {
    byId.clear();
    $('#email-count').textContent = total > 0 ? `共 ${total} 封` : '';
    renderUnreadCount(unreadCount);

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
        <tr class="clickable${e.is_read ? '' : ' is-unread'}" data-id="${e.id}" tabindex="0" aria-label="${e.is_read ? '' : '未读邮件：'}${escapeHtml(e.subject || '无主题')}">
          <td class="cell-from" data-label="发件人" title="${escapeHtml(e.from_addr)}">
            <span class="unread-dot" aria-hidden="true"></span>
            <span class="sr-only">${e.is_read ? '已读' : '未读'}</span>
            <span class="mono">${escapeHtml(e.from_addr)}</span>
          </td>
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
            <small>请确认发送域名已接入 Cloudflare Email Sending，并已为 Worker 添加 EMAIL binding。</small>`;
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
        if (!summary.is_read) {
          try {
            const result = await api(`/emails/${summary.id}/read`, { method: 'PATCH' });
            summary.is_read = true;
            const row = tbody().querySelector(`tr[data-id="${summary.id}"]`);
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

  return { load, loadUnreadCount, init };
})();

export { emailsView };
