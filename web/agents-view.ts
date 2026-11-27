import type { AgentTokenSummary, CreatedAgentTokenResponse, McpAdminResponse } from './api-types.js';
import { $, ICONS, api, closeModal, confirmDialog, copyText, errorMessage, escapeHtml } from './app.js';
import { fullTime, isUnauthorized, openModal, relTime, toast } from './app.js';

// ── Agent 接入 (MCP) view ──

type ClientKey = 'json' | 'claude' | 'codex';

interface Snippet {
  label: string;
  code: string;
}

// The placeholder matches the ${NAME} env-var syntax that Claude Code and most
// MCP managers expand inside .mcp.json, so the template works unedited once
// the variable is set.
const TOKEN_PLACEHOLDER = '${MAILCAST_MCP_TOKEN}';

const EXPIRY_OPTIONS = [
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: '365', label: '1 年' },
  { value: '', label: '永不过期' },
];

const agentsView = (() => {
  let mcpData: McpAdminResponse | null = null;

  function endpointUrl(): string {
    return `${window.location.origin}${mcpData?.endpoint_path || '/mcp'}`;
  }

  function buildSnippets(token: string): Record<ClientKey, Snippet> {
    const endpoint = endpointUrl();
    return {
      json: {
        label: 'JSON',
        code: JSON.stringify({
          mcpServers: {
            mailcast: { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${token}` } },
          },
        }, null, 2),
      },
      claude: {
        label: 'Claude Code',
        code: `claude mcp add --transport http mailcast ${endpoint} \\\n  --header "Authorization: Bearer ${token}"`,
      },
      codex: {
        label: 'Codex',
        code: [
          '[mcp_servers.mailcast]',
          `url = "${endpoint}"`,
          `http_headers = { Authorization = "Bearer ${token}" }`,
        ].join('\n'),
      },
    };
  }

  // One code block with client tabs and a copy button in its header bar,
  // shared by the page (placeholder token) and the created-token modal (real
  // token) so both show the same thing in the same place.
  function mountSnippet(host: HTMLElement, token: string) {
    const snippets = buildSnippets(token);
    let current: ClientKey = 'json';
    host.innerHTML = `
      <div class="mcp-snippet">
        <div class="mcp-snippet-bar">
          <div class="mcp-snippet-tabs" role="tablist" aria-label="客户端">
            ${(Object.keys(snippets) as ClientKey[]).map((key) => `
              <button type="button" role="tab" data-client="${key}" aria-selected="${key === current}">${snippets[key].label}</button>`).join('')}
          </div>
          <button type="button" class="mcp-snippet-copy" data-snippet-copy>${ICONS.copy}<span>复制</span></button>
        </div>
        <pre class="mcp-snippet-code"><code>${escapeHtml(snippets[current].code)}</code></pre>
      </div>`;

    const code = $('.mcp-snippet-code code', host);
    host.querySelectorAll<HTMLButtonElement>('[data-client]').forEach((tab) => {
      tab.addEventListener('click', () => {
        current = tab.dataset.client as ClientKey;
        host.querySelectorAll<HTMLButtonElement>('[data-client]').forEach((other) => {
          other.setAttribute('aria-selected', String(other === tab));
        });
        code.textContent = snippets[current].code;
      });
    });
    $('[data-snippet-copy]', host).addEventListener('click', () => {
      void copyText(snippets[current].code, `${snippets[current].label} 配置`);
    });
  }

  function tokenRow(token: AgentTokenSummary): string {
    const statusLabel = { active: '有效', revoked: '已吊销', expired: '已过期' }[token.status];
    const allPrefixes = token.prefixes.includes('*');
    const prefixTags = allPrefixes
      ? '<span class="mcp-tag is-warn">全部前缀</span>'
      : token.prefixes.map((p) => `<span class="mcp-tag mono">${escapeHtml(p)}@</span>`).join('');
    const canSend = token.scopes.includes('mail:send');
    const scopeTags = [
      token.scopes.includes('mail:read') ? '<span class="mcp-tag">读取</span>' : '',
      canSend
        ? `<span class="mcp-tag${token.recipient_policy === 'any' ? ' is-warn' : ''}">发信 · ${token.recipient_policy === 'any'
          ? '不限收件人'
          : `白名单 ${token.recipient_allowlist.length}`}</span>`
        : '',
    ].join('');
    const meta = [
      `<code>${escapeHtml(token.token_hint)}</code>`,
      token.last_used_at
        ? `${escapeHtml(relTime(token.last_used_at))}使用${token.last_used_ip ? ` · ${escapeHtml(token.last_used_ip)}` : ''}`
        : '尚未使用',
      token.expires_at ? `${escapeHtml(fullTime(token.expires_at).slice(0, 10))} 到期` : '永不过期',
      canSend ? `${token.send_limit_hour}/时 · ${token.send_limit_day}/天` : '',
    ].filter(Boolean).join('<span class="mcp-sep">·</span>');

    return `
      <article class="mcp-token-row is-${escapeHtml(token.status)}">
        <div class="mcp-token-main">
          <div class="mcp-token-title">
            <strong>${escapeHtml(token.name)}</strong>
            <span class="mcp-state is-${escapeHtml(token.status)}">${statusLabel}</span>
          </div>
          <div class="mcp-token-tags">${prefixTags}${token.allow_plus_tags && !allPrefixes ? '<span class="mcp-tag mono">+tag</span>' : ''}${scopeTags}</div>
          <div class="mcp-token-meta">${meta}</div>
        </div>
        ${token.status === 'active'
          ? `<button type="button" class="btn btn-sm btn-ghost mcp-danger-link" data-revoke-token="${token.id}">吊销</button>`
          : ''}
      </article>`;
  }

  function render() {
    if (!mcpData) return;
    const { settings, tokens, usage } = mcpData;
    const activeCount = tokens.filter((t) => t.status === 'active').length;

    $<HTMLInputElement>('#mcp-enabled').checked = settings.enabled;
    $('#mcp-status-desc').textContent = settings.enabled
      ? '已启用，有效 Token 可以连接。'
      : '已停用，所有 Token 暂时无法连接；重新启用后恢复。';
    $('#mcp-endpoint-url').textContent = endpointUrl();

    $<HTMLInputElement>('#mcp-daily-limit').value = String(settings.daily_send_limit);
    const limit = settings.daily_send_limit;
    const used = usage.instance_day_used;
    $('#mcp-usage-count').textContent = `${used} / ${limit}`;
    const bar = $('#mcp-usage-bar');
    bar.style.width = `${limit > 0 ? Math.min(100, (used / limit) * 100) : 0}%`;
    bar.classList.toggle('is-full', limit > 0 && used >= limit);

    $('#mcp-token-count').textContent = tokens.length ? `${activeCount} 个有效` : '';
    $('#mcp-tokens-footer').hidden = activeCount < 2;
    $('#mcp-tokens-list').innerHTML = tokens.length
      ? tokens.map(tokenRow).join('')
      : `
        <div class="mcp-empty">
          <span class="mcp-empty-icon">${ICONS.key}</span>
          <strong>还没有 Token</strong>
          <small>新建一个 Token，再把配置粘贴进 Claude Code 或 Codex。</small>
        </div>`;
  }

  async function refresh() {
    mcpData = await api<McpAdminResponse>('/settings/mcp');
    render();
  }

  async function load() {
    try {
      await refresh();
    } catch (error) {
      if (!isUnauthorized(error)) toast(`加载 Agent 接入设置失败：${errorMessage(error)}`, 'error');
    }
  }

  async function saveSettings(enabled: boolean, dailySendLimit: number) {
    await api('/settings/mcp', {
      method: 'PUT',
      body: JSON.stringify({ enabled, daily_send_limit: dailySendLimit }),
    });
    await refresh();
  }

  function openCreatedModal(created: CreatedAgentTokenResponse) {
    const overlay = openModal(`
      <div class="modal-header">
        <div class="modal-heading">
          <h3 class="modal-title">Token 已创建</h3>
          <p class="modal-subtitle">${escapeHtml(created.item.name)}</p>
        </div>
        <button type="button" class="icon-btn" data-act="close" title="关闭" aria-label="关闭">${ICONS.close}</button>
      </div>
      <div class="modal-body mcp-modal-body">
        <p class="mcp-notice">${ICONS.alert}<span>完整 Token 只显示这一次。关闭前请复制，或直接把下方配置粘贴进客户端。</span></p>
        <div class="field">
          <span class="field-label">Token</span>
          <div class="mcp-copy-field">
            <code>${escapeHtml(created.token)}</code>
            <button type="button" class="icon-btn" data-copy-token title="复制 Token" aria-label="复制 Token">${ICONS.copy}</button>
          </div>
        </div>
        <div class="field">
          <span class="field-label">客户端配置</span>
          <div data-snippet-host></div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-primary" data-act="close">完成</button>
      </div>
    `);
    overlay.querySelectorAll('[data-act="close"]').forEach((btn) => btn.addEventListener('click', closeModal));
    $('[data-copy-token]', overlay).addEventListener('click', () => void copyText(created.token, 'Token'));
    mountSnippet($('[data-snippet-host]', overlay), created.token);
  }

  function openCreateModal() {
    const knownPrefixes = mcpData?.known_prefixes ?? [];
    const defaultPrefix = knownPrefixes[0] || 'agent';
    const overlay = openModal(`
      <form id="mcp-create-token-form" novalidate>
        <div class="modal-header">
          <div class="modal-heading">
            <h3 class="modal-title">新建 Token</h3>
            <p class="modal-subtitle">只授予 Agent 完成任务所需的前缀和权限。</p>
          </div>
          <button type="button" class="icon-btn" data-act="close" title="关闭" aria-label="关闭">${ICONS.close}</button>
        </div>
        <div class="modal-body mcp-modal-body">
          <div class="field">
            <label class="field-label" for="mcp-token-name">名称</label>
            <input id="mcp-token-name" type="text" maxlength="60" placeholder="例如：Codex 本机 / 注册验证码" autocomplete="off" required>
          </div>

          <div class="field">
            <label class="field-label" for="mcp-token-prefixes">可访问的前缀</label>
            <input id="mcp-token-prefixes" type="text" value="${escapeHtml(defaultPrefix)}" placeholder="agent, ci" autocomplete="off" spellcheck="false" required>
            <div class="mcp-chips" role="group" aria-label="常用前缀">
              ${knownPrefixes.slice(0, 12).map((p) => `<button type="button" class="mcp-chip" data-prefix="${escapeHtml(p)}" aria-pressed="false">${escapeHtml(p)}</button>`).join('')}
              <button type="button" class="mcp-chip is-wildcard" data-prefix="*" aria-pressed="false">全部 *</button>
            </div>
            <label class="checkbox-row mcp-subtle-check">
              <input id="mcp-token-plus-tags" type="checkbox" checked>
              <span>读取时包含 +tag 子地址，例如 ci 也能读 ci+github@</span>
            </label>
          </div>

          <div class="field">
            <span class="field-label">权限</span>
            <div class="mcp-scope-grid">
              <label class="mcp-scope">
                <input id="mcp-scope-read" type="checkbox" checked>
                <span class="mcp-scope-text"><strong>读取邮件</strong><small>查信、读信、等待验证码</small></span>
              </label>
              <label class="mcp-scope">
                <input id="mcp-scope-send" type="checkbox">
                <span class="mcp-scope-text"><strong>发送与回复</strong><small>发新信、回复、查看发件记录</small></span>
              </label>
            </div>
          </div>

          <div id="mcp-send-guardrails" class="mcp-guardrails" hidden>
            <div class="field">
              <label class="field-label" for="mcp-recipient-policy">收件人</label>
              <select id="mcp-recipient-policy">
                <option value="allowlist">只能发给白名单（推荐）</option>
                <option value="any">可以发给任意地址</option>
              </select>
            </div>
            <div class="field" id="mcp-allowlist-field">
              <label class="field-label" for="mcp-recipient-allowlist">白名单</label>
              <textarea id="mcp-recipient-allowlist" rows="3" placeholder="alice@example.com&#10;@company.com" spellcheck="false"></textarea>
              <small class="field-help">每行一个完整地址，或用 @company.com 放行整个域名。</small>
            </div>
            <div class="mcp-limit-grid">
              <div class="field">
                <label class="field-label" for="mcp-limit-hour">每小时上限</label>
                <input id="mcp-limit-hour" type="number" min="1" max="1000" value="10">
              </div>
              <div class="field">
                <label class="field-label" for="mcp-limit-day">每日上限</label>
                <input id="mcp-limit-day" type="number" min="1" max="10000" value="30">
              </div>
            </div>
          </div>

          <div class="field">
            <span class="field-label">有效期</span>
            <div class="segmented mcp-expiry" role="group" aria-label="有效期">
              ${EXPIRY_OPTIONS.map((o) => `<button type="button" data-expiry="${o.value}" aria-pressed="${o.value === '90'}">${o.label}</button>`).join('')}
            </div>
          </div>

          <div id="mcp-risk-warning" class="mcp-notice is-risk" role="alert" hidden></div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" data-act="close">取消</button>
          <button type="submit" class="btn btn-primary">创建</button>
        </div>
      </form>
    `);

    const prefixesInput = $<HTMLInputElement>('#mcp-token-prefixes', overlay);
    const readCheck = $<HTMLInputElement>('#mcp-scope-read', overlay);
    const sendCheck = $<HTMLInputElement>('#mcp-scope-send', overlay);
    const policySelect = $<HTMLSelectElement>('#mcp-recipient-policy', overlay);
    const riskWarning = $('#mcp-risk-warning', overlay);
    let expiry = '90';

    const parsePrefixes = () => prefixesInput.value
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    // The text input is the single source of truth; chips only mirror it, so
    // typing a known prefix by hand lights its chip too.
    const sync = () => {
      const prefixes = parsePrefixes();
      overlay.querySelectorAll<HTMLButtonElement>('[data-prefix]').forEach((chip) => {
        chip.setAttribute('aria-pressed', String(prefixes.includes(chip.dataset.prefix ?? '')));
      });
      const canSend = sendCheck.checked;
      $('#mcp-send-guardrails', overlay).hidden = !canSend;
      $('#mcp-allowlist-field', overlay).hidden = policySelect.value !== 'allowlist';

      const warnings: string[] = [];
      if (prefixes.includes('*')) warnings.push('「全部 *」可以访问实例里所有收件地址。');
      if (readCheck.checked && canSend && policySelect.value === 'any') {
        warnings.push('同时能读信、又能发往任意地址：如果邮件里藏有 Prompt Injection，Agent 可能把内容转发出去。建议改用白名单。');
      }
      riskWarning.innerHTML = warnings.length ? `${ICONS.alert}<span>${warnings.map(escapeHtml).join(' ')}</span>` : '';
      riskWarning.hidden = warnings.length === 0;
    };

    overlay.querySelectorAll('[data-act="close"]').forEach((btn) => btn.addEventListener('click', closeModal));
    overlay.querySelectorAll<HTMLButtonElement>('[data-prefix]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const value = chip.dataset.prefix ?? '';
        const current = parsePrefixes();
        let next: string[];
        if (current.includes(value)) next = current.filter((p) => p !== value);
        else if (value === '*') next = ['*'];
        else next = [...current.filter((p) => p !== '*'), value];
        prefixesInput.value = next.join(', ');
        sync();
      });
    });
    overlay.querySelectorAll<HTMLButtonElement>('[data-expiry]').forEach((btn) => {
      btn.addEventListener('click', () => {
        expiry = btn.dataset.expiry ?? '';
        overlay.querySelectorAll<HTMLButtonElement>('[data-expiry]').forEach((other) => {
          other.setAttribute('aria-pressed', String(other === btn));
        });
      });
    });
    [prefixesInput, readCheck, sendCheck, policySelect].forEach((el) => {
      el.addEventListener(el === prefixesInput ? 'input' : 'change', sync);
    });
    sync();

    const form = $<HTMLFormElement>('#mcp-create-token-form', overlay);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = $<HTMLButtonElement>('button[type="submit"]', form);
      button.disabled = true;
      try {
        const created = await api<CreatedAgentTokenResponse>('/settings/mcp/tokens', {
          method: 'POST',
          body: JSON.stringify({
            name: $<HTMLInputElement>('#mcp-token-name', form).value.trim(),
            scopes: [
              ...(readCheck.checked ? ['mail:read'] : []),
              ...(sendCheck.checked ? ['mail:send'] : []),
            ],
            prefixes: parsePrefixes(),
            allow_plus_tags: $<HTMLInputElement>('#mcp-token-plus-tags', form).checked,
            recipient_policy: policySelect.value,
            recipient_allowlist: $<HTMLTextAreaElement>('#mcp-recipient-allowlist', form).value
              .split(/[\n,]+/)
              .map((item) => item.trim())
              .filter(Boolean),
            send_limit_hour: Number($<HTMLInputElement>('#mcp-limit-hour', form).value) || 10,
            send_limit_day: Number($<HTMLInputElement>('#mcp-limit-day', form).value) || 30,
            expires_in_days: expiry ? Number(expiry) : null,
          }),
        });
        closeModal();
        await refresh();
        openCreatedModal(created);
      } catch (error) {
        if (!isUnauthorized(error)) toast(`创建失败：${errorMessage(error)}`, 'error');
      } finally {
        button.disabled = false;
      }
    });

    $('#mcp-token-name', overlay).focus();
  }

  function init() {
    // The page snippet uses the placeholder; window.location.origin is all it
    // needs, so it can render before the settings request returns.
    mountSnippet($('#mcp-config-snippet'), TOKEN_PLACEHOLDER);
    $('#mcp-endpoint-url').textContent = endpointUrl();
    $('#mcp-copy-endpoint').innerHTML = ICONS.copy;
    $('#mcp-copy-endpoint').addEventListener('click', () => void copyText(endpointUrl(), '端点地址'));
    $('#mcp-create-token').addEventListener('click', openCreateModal);

    // The switch saves on change: it is the kill switch for every token, so
    // making it wait for a separate save button would hide that it took effect.
    const enabledSwitch = $<HTMLInputElement>('#mcp-enabled');
    enabledSwitch.addEventListener('change', async () => {
      if (!mcpData) return;
      const enabled = enabledSwitch.checked;
      if (!enabled) {
        const confirmed = await confirmDialog({
          title: '停用 MCP 服务',
          message: '停用后所有 Token 立即无法连接，正在运行的 Agent 会失去访问权限。Token 本身会保留，重新启用即可恢复。',
          confirmText: '停用',
        });
        if (!confirmed) {
          enabledSwitch.checked = true;
          return;
        }
      }
      enabledSwitch.disabled = true;
      try {
        await saveSettings(enabled, mcpData.settings.daily_send_limit);
        toast(enabled ? 'MCP 服务已启用' : 'MCP 服务已停用', 'success');
      } catch (error) {
        enabledSwitch.checked = !enabled;
        if (!isUnauthorized(error)) toast(`保存失败：${errorMessage(error)}`, 'error');
      } finally {
        enabledSwitch.disabled = false;
      }
    });

    $('#mcp-settings-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!mcpData) return;
      const form = event.target as HTMLFormElement;
      const button = $<HTMLButtonElement>('button[type="submit"]', form);
      button.disabled = true;
      try {
        await saveSettings(mcpData.settings.enabled, Number($<HTMLInputElement>('#mcp-daily-limit', form).value));
        toast('发信额度已保存', 'success');
      } catch (error) {
        if (!isUnauthorized(error)) toast(`保存失败：${errorMessage(error)}`, 'error');
      } finally {
        button.disabled = false;
      }
    });

    $('#mcp-revoke-all').addEventListener('click', async () => {
      const confirmed = await confirmDialog({
        title: '吊销全部 Token',
        message: '所有有效 Token 会立即失效，正在运行的 Agent 将失去访问权限。此操作无法撤销。',
        confirmText: '全部吊销',
      });
      if (!confirmed) return;
      try {
        await api('/settings/mcp/tokens/revoke-all', { method: 'POST' });
        await refresh();
        toast('已吊销全部 Token', 'success');
      } catch (error) {
        if (!isUnauthorized(error)) toast(`吊销失败：${errorMessage(error)}`, 'error');
      }
    });

    $('#mcp-tokens-list').addEventListener('click', async (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-revoke-token]');
      if (!button || button.disabled) return;
      const token = mcpData?.tokens.find((item) => String(item.id) === button.dataset.revokeToken);
      if (!token) return;
      const confirmed = await confirmDialog({
        title: '吊销 Token',
        message: `确定吊销「${token.name}」（${token.token_hint}）吗？吊销后无法恢复，审计记录会保留。`,
        confirmText: '吊销',
      });
      if (!confirmed) return;
      button.disabled = true;
      try {
        await api(`/settings/mcp/tokens/${token.id}/revoke`, { method: 'POST' });
        await refresh();
        toast('Token 已吊销', 'success');
      } catch (error) {
        if (!isUnauthorized(error)) toast(`吊销失败：${errorMessage(error)}`, 'error');
        button.disabled = false;
      }
    });
  }

  return { load, init };
})();

export { agentsView };
