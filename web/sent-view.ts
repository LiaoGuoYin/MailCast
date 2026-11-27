import type { SentListItem, SentListResponse } from './api-types.js';
import {
  $, ICONS, api, emptyStateHtml, errorMessage, errorStateHtml, escapeHtml, fullTime,
  isUnauthorized, relTime,
} from './app.js';

// ── Sent history view ──
// Every outbound email (console compose, inbox replies, Agent MCP sends) lands in
// sent_emails, so this one list covers all of them, newest first.

const sentView = (() => {
  const LIMIT = 30;
  const PROVIDER_LABELS: Record<string, string> = {
    resend: 'Resend',
    cloudflare: 'Cloudflare Email',
  };
  let items: SentListItem[] = [];
  let nextBeforeId: number | null = null;
  let loadingMore = false;
  let seq = 0;

  const list = () => $('#sent-list');
  const state = () => $('#sent-state');
  const moreBtn = () => $<HTMLButtonElement>('#sent-load-more');

  function showList() {
    state().hidden = true;
    list().hidden = false;
  }

  function showSentState(html: string) {
    list().hidden = true;
    state().hidden = false;
    state().innerHTML = html;
    moreBtn().hidden = true;
  }

  function renderLoading() {
    showList();
    moreBtn().hidden = true;
    list().innerHTML = Array.from({ length: 6 }, (_, index) => `
      <div class="sent-row" aria-hidden="true">
        <div class="sent-summary">
          <span class="skeleton" style="width:${42 + (index % 3) * 12}%"></span>
          <span class="skeleton" style="width:28%;height:10px;margin-top:7px"></span>
        </div>
      </div>`).join('');
  }

  // Reload from the newest page; called on every tab entry so a just-sent email shows up.
  async function load({ quiet = false } = {}) {
    const my = ++seq;
    if (!quiet) renderLoading();
    try {
      const result = await api<SentListResponse>(`/outbound/sent?limit=${LIMIT}`);
      if (my !== seq) return;
      items = result.data;
      nextBeforeId = result.has_more ? result.next_before_id : null;
      render();
    } catch (error) {
      if (my !== seq || isUnauthorized(error)) return;
      showSentState(errorStateHtml(errorMessage(error)));
    }
  }

  async function loadMore() {
    if (loadingMore || nextBeforeId === null) return;
    loadingMore = true;
    const my = seq;
    const button = moreBtn();
    button.disabled = true;
    button.textContent = '加载中…';
    try {
      const result = await api<SentListResponse>(`/outbound/sent?limit=${LIMIT}&before_id=${nextBeforeId}`);
      // A full reload started meanwhile; its result owns the list now.
      if (my !== seq) return;
      items = [...items, ...result.data];
      nextBeforeId = result.has_more ? result.next_before_id : null;
      render();
    } catch (error) {
      if (!isUnauthorized(error)) button.textContent = `加载失败：${errorMessage(error)}，点击重试`;
      button.disabled = false;
      return;
    } finally {
      loadingMore = false;
    }
  }

  function sourceLabel(item: SentListItem): string {
    if (item.agent_token_id) return `Agent · ${item.agent_token_name || `#${item.agent_token_id}`}`;
    if (item.reply_to_email_id) return '回复';
    return '控制台';
  }

  function render() {
    $('#sent-count').textContent = items.length
      ? `${nextBeforeId === null ? '共' : '已加载'} ${items.length} 封`
      : '';

    if (!items.length) {
      showSentState(emptyStateHtml(ICONS.send, '还没有发出过邮件', '从控制台写信、回复收件或 Agent 发出的邮件都会显示在这里'));
      return;
    }

    showList();
    list().innerHTML = items.map((item) => {
      const failed = item.status === 'failed';
      const snippet = String(item.text_body || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      const meta: Array<[string, string]> = [
        ['发件人', item.from_addr],
        ['收件人', item.to_addr],
        ['Reply-To', item.reply_to],
        ['发送通道', PROVIDER_LABELS[item.provider] || item.provider],
        ['Message ID', item.provider_message_id],
        ['幂等键', item.idempotency_key ?? ''],
        ['发送时间', fullTime(item.created_at)],
      ];
      const metaHtml = meta
        .filter(([, value]) => value)
        .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`)
        .join('');
      return `
        <details class="sent-row${failed ? ' is-failed' : ''}" data-sent-id="${item.id}">
          <summary class="sent-summary">
            <div class="sent-line">
              <span class="sent-status status-${failed ? 'failed' : 'success'}" title="${failed ? '发送失败' : '已发送'}"><i></i>${failed ? '失败' : '已发送'}</span>
              <strong class="sent-to mono" title="${escapeHtml(item.to_addr)}">${escapeHtml(item.to_addr)}</strong>
              <time class="sent-time" title="${escapeHtml(fullTime(item.created_at))}">${escapeHtml(relTime(item.created_at))}</time>
            </div>
            <div class="sent-subject">${escapeHtml(item.subject || '（无主题）')}</div>
            <div class="sent-line sent-line-sub">
              <span class="mail-prefix-tag" title="发件地址：${escapeHtml(item.from_addr)}">${escapeHtml(item.from_prefix)}</span>
              <span class="sent-source">${escapeHtml(sourceLabel(item))}</span>
              ${snippet ? `<span class="sent-snippet">${escapeHtml(snippet)}</span>` : ''}
            </div>
          </summary>
          <div class="sent-detail">
            ${item.error ? `<div class="downstream-error">${escapeHtml(item.error)}</div>` : ''}
            <dl class="log-detail-grid">${metaHtml}</dl>
            <pre class="sent-body">${escapeHtml(item.text_body || '')}</pre>
          </div>
        </details>`;
    }).join('');

    const button = moreBtn();
    button.hidden = nextBeforeId === null;
    button.disabled = false;
    button.textContent = '加载更多';
  }

  function init() {
    $('#sent-refresh').addEventListener('click', () => load());
    moreBtn().addEventListener('click', () => loadMore());
    state().addEventListener('click', (event) => {
      if ((event.target as Element).closest('[data-retry]')) load();
    });
  }

  return { load, init };
})();

export { sentView };
