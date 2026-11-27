import type { LogListResponse } from './api-types.js';
import {
  $, ICONS, activeTab, api, debounce, emptyStateHtml, errorMessage, errorStateHtml, escapeHtml, fullTime,
  isUnauthorized, relTime,
} from './app.js';

// ── Logs view ──

const logsView = (() => {
  const CATEGORY_LABELS: Record<string, string> = {
    delivery: '投递',
    auth: '认证',
    bot: 'Bot',
    rule: '规则',
    settings: '设置',
    email: '邮件',
  };
  const DETAIL_LABELS: Record<string, string> = {
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
    tool: 'MCP 工具',
    agent_token_name: 'Agent Token',
    agent_token_id: 'Token ID',
    to_prefix: '收件前缀',
    from: '发件人',
    to: '收件人',
    subject: '主题',
    idempotency_key: '幂等键',
    scopes: '权限范围',
    prefixes: '允许前缀',
    allow_plus_tags: '允许 +tag 子地址',
    recipient_policy: '收件人策略',
    send_limit_hour: '每小时发信上限',
    send_limit_day: '每日发信上限',
    daily_send_limit: '实例每日发信上限',
    revoked_count: '已吊销数量',
  };
  const SENSITIVE_DETAIL_RE = /password|token_hash|api[_-]?key|secret/i;
  const LIMIT = 30;
  let page = 1;
  let query = '';
  let category = '';
  let status = '';
  let actor = '';
  let seq = 0;

  const list = () => $('#logs-list');
  const state = () => $('#logs-state');

  function showList() {
    state().hidden = true;
    list().hidden = false;
  }

  function showLogsState(html: string) {
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
    if (actor) params.set('actor', actor);

    try {
      const result = await api<LogListResponse>(`/logs?${params}`);
      if (my !== seq) return;
      render(result);
    } catch (error) {
      if (my !== seq || isUnauthorized(error)) return;
      if (!quiet || !list().children.length) showLogsState(errorStateHtml(errorMessage(error)));
    }
  }

  function render({ data, total, page: currentPage, limit }: LogListResponse) {
    $('#log-count').textContent = total ? `共 ${total} 条` : '';
    const totalPages = Math.max(1, Math.ceil(total / limit));
    $('#logs-pagination').hidden = totalPages <= 1;
    $('#logs-page-info').textContent = `第 ${currentPage} / ${totalPages} 页 · 共 ${total} 条`;
    $<HTMLButtonElement>('#logs-page-prev').disabled = currentPage <= 1;
    $<HTMLButtonElement>('#logs-page-next').disabled = currentPage >= totalPages;

    if (!data?.length) {
      $('#logs-pagination').hidden = true;
      showLogsState(emptyStateHtml(
        ICONS.activity,
        query || category || status || actor ? '没有匹配的日志' : '暂无操作日志',
        query || category || status || actor ? '尝试调整搜索词或筛选条件' : '后续管理操作和投递结果会显示在这里',
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
      const agentName = typeof item.details?.agent_token_name === 'string' && item.details.agent_token_name
        ? item.details.agent_token_name
        : item.actor_id ? `#${item.actor_id}` : '';
      const actorLabel = item.actor === 'system'
        ? '系统'
        : item.actor === 'agent'
          ? (agentName ? `Agent · ${agentName}` : 'Agent')
          : '管理员';
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
              <span>${escapeHtml(actorLabel)}</span>
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
    $('#log-search').addEventListener('input', debounce((event: Event) => {
      query = (event.target as HTMLInputElement).value.trim();
      page = 1;
      load();
    }, 300));
    $('#log-category').addEventListener('change', (event) => {
      category = (event.target as HTMLSelectElement).value;
      page = 1;
      load();
    });
    $('#log-status').addEventListener('change', (event) => {
      status = (event.target as HTMLSelectElement).value;
      page = 1;
      load();
    });
    $('#log-actor').addEventListener('change', (event) => {
      actor = (event.target as HTMLSelectElement).value;
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
      if ((event.target as Element).closest('[data-retry]')) load();
    });
    setInterval(() => {
      if (activeTab === 'logs' && !$('#app').classList.contains('hidden')) {
        void load({ quiet: true });
      }
    }, 15_000);
  }

  return { load, init };
})();

export { logsView };
