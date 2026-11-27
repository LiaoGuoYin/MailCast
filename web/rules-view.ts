import type {
  BarkRule, ChannelKey, ChannelRule, DownstreamStatus, ForwardRule, RuleActivity, SettingsResponse, SetupStatus,
  TgRule,
} from './api-types.js';
import { $, ApiError, CHANNELS, ICONS, api, barkEndpointOptions, closeModal, confirmDialog, copyText } from './app.js';
import { emailDestinationOptions, emptyStateHtml, errorDetails, errorMessage, errorStateHtml, escapeHtml } from './app.js';
import { isUnauthorized, loadDestinationCatalogs, loadTelegramBotCatalog, loadedTabs } from './app.js';
import { fullTime, openBarkDestinationCreateModal, openEmailDestinationCreateModal, openModal } from './app.js';
import { openTelegramBotCreateModal, relTime, ruleCatalogEmpty, showState, showTable, telegramBotOptions, toast } from './app.js';
import type { RulePayload } from './app.js';
import { buildRoutingGraph } from './routing-graph.js';
import type { OutletPreset } from './routing-graph.js';
import { mountRoutingGraph } from './routing-graph-view.js';
import { buildRoutingTable } from './routing-table.js';
import type { Route, RouteOutlet } from './routing-table.js';
import { ROUTES_VIEW_KEY } from './storage.js';

// What the rule form starts from: the rule being edited, a graph outlet's
// preset, or nothing.
interface RuleFormValues {
  channel?: ChannelKey;
  destination_id?: number;
  endpoint_id?: number;
  chat_id?: string;
  bot_id?: number | null;
}

interface RuleModalOptions {
  rule?: ChannelRule | null;
  prefix?: string;
  preset?: OutletPreset | null;
}

function isChannelKey(value: string): value is ChannelKey {
  return value === 'forward' || value === 'tg' || value === 'bark';
}

const rulesView = (() => {
  let seq = 0;
  let mailDomain = '';
  const byId = new Map<string, ChannelRule>();
  // Survives reloads so toggling or deleting an outlet keeps its route open.
  const expandedPrefixes = new Set<string>();
  // The last loaded data, so switching to the graph needs no extra request.
  let lastRules: ChannelRule[] = [];
  let lastActivity: Partial<RuleActivity> = {};
  let graph: ReturnType<typeof mountRoutingGraph> | null = null;

  const listEl = () => $('#rules-groups');
  const stateEl = () => $('#rules-state');

  function keyOf(rule: ChannelRule) {
    return `${rule.channel}:${rule.id}`;
  }

  async function load() {
    const my = ++seq;
    showTable(stateEl(), listEl());
    if (!listEl().children.length) {
      listEl().innerHTML = Array.from({ length: 3 }, () => `
        <section class="route-row route-row-skeleton" aria-hidden="true">
          <div class="route-head"><span class="skeleton" style="width:180px"></span><span class="skeleton" style="width:60%"></span></div>
        </section>`).join('');
    }

    let rules: ChannelRule[];
    let activity: RuleActivity;
    try {
      const [forwardRules, tgRules, barkRules, , , settings, routingActivity, setup] = await Promise.all([
        api<ForwardRule[]>(CHANNELS.forward.endpoint),
        api<TgRule[]>(CHANNELS.tg.endpoint),
        api<BarkRule[]>(CHANNELS.bark.endpoint),
        loadTelegramBotCatalog(),
        loadDestinationCatalogs(),
        optional(api<SettingsResponse>('/settings'), { mail_domain: '' }),
        // Status lights are a bonus: a failed activity query must not hide the routes.
        optional(api<RuleActivity>('/rules/activity'), { deliveries: [], prefixes: [] }),
        optional(api<SetupStatus>('/setup'), null),
      ]);
      // The receiving domain is what the customer types into sign-up forms, so
      // prefer it over the sender domain, which may be a sending subdomain.
      mailDomain = setup?.receiving?.domain || settings.mail_domain || '';
      activity = routingActivity;
      rules = [
        ...forwardRules.map((rule) => ({ ...rule, channel: 'forward' as const })),
        ...tgRules.map((rule) => ({ ...rule, channel: 'tg' as const })),
        ...barkRules.map((rule) => ({ ...rule, channel: 'bark' as const })),
      ];
    } catch (err) {
      if (my !== seq || isUnauthorized(err)) return;
      listEl().innerHTML = '';
      graph?.render(null);
      showState(stateEl(), listEl(), errorStateHtml(errorMessage(err)));
      return;
    }
    if (my !== seq) return;
    render(rules, activity);
  }

  function optional<T, F>(promise: Promise<T>, fallback: F): Promise<T | F> {
    return promise.catch((error: unknown) => {
      if (isUnauthorized(error)) throw error;
      return fallback;
    });
  }

  function addressOf(prefix: string) {
    return prefix === '*' ? '其他所有地址' : `${prefix}@${mailDomain || '你的域名'}`;
  }

  const CHANNEL_SHORT: Record<ChannelKey, string> = { forward: '邮件', tg: 'TG', bark: 'Bark' };
  const DELIVERY_TEXT: Record<DownstreamStatus, string> = { success: '最近投递成功', failed: '最近投递失败', pending: '投递中' };

  function lightOf(outlet: RouteOutlet) {
    if (outlet.inherited) return 'inherited';
    if (!outlet.enabled) return 'off';
    return outlet.delivery?.status || 'idle';
  }

  function lightLabel(outlet: RouteOutlet) {
    if (outlet.inherited) return '继承自 *';
    if (!outlet.enabled) return '已停用';
    if (!outlet.delivery) return '尚无投递记录';
    return `${DELIVERY_TEXT[outlet.delivery.status] || outlet.delivery.status} · ${relTime(outlet.delivery.at)}`;
  }

  function renderChip(outlet: RouteOutlet) {
    const light = lightOf(outlet);
    return `<span class="route-chip is-${light} chip-${outlet.channel}" title="${escapeHtml(`${outlet.label} · ${lightLabel(outlet)}`)}">
      <i class="route-light" aria-hidden="true"></i><b>${CHANNEL_SHORT[outlet.channel]}</b><span>${escapeHtml(outlet.label)}</span>${outlet.inherited ? '<small>*</small>' : ''}
      <span class="sr-only">${escapeHtml(lightLabel(outlet))}</span>
    </span>`;
  }

  function routeMeta(route: Route) {
    if (route.wildcard) return '与每个地址的专属规则同时生效';
    if (!route.lastReceivedAt) return '尚未收到邮件';
    return `最近收信 ${relTime(route.lastReceivedAt)} · 共 ${route.emailCount} 封`;
  }

  function currentView() {
    return $('#rules-panel').dataset.view;
  }

  // Rebuilt from the rule objects in byId, which table toggles update in place,
  // so the graph never shows a stale enabled state.
  function renderGraph() {
    if (currentView() !== 'graph' || !graph) return;
    graph.render(lastRules.length || lastActivity.prefixes?.length
      ? buildRoutingGraph(lastRules, lastActivity)
      : null);
  }

  function setView(view: string | null | undefined) {
    const next = view === 'graph' ? 'graph' : 'table';
    $('#rules-panel').dataset.view = next;
    document.querySelectorAll<HTMLElement>('[data-routes-view]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.routesView === next));
    });
    localStorage.setItem(ROUTES_VIEW_KEY, next);
    renderGraph();
  }

  function render(rules: ChannelRule[], activity: RuleActivity) {
    lastRules = rules;
    lastActivity = activity || {};
    byId.clear();
    for (const rule of rules) byId.set(keyOf(rule), rule);
    const routes = buildRoutingTable(rules, activity);
    const subtitle = document.querySelector('#routes-subtitle');
    if (subtitle) {
      subtitle.textContent = mailDomain
        ? `发往 @${mailDomain} 的邮件会按前缀送往这些出口`
        : '每个收件地址收到的邮件会送往哪些出口';
    }

    if (!routes.length) {
      listEl().innerHTML = '';
      showState(stateEl(), listEl(), `${emptyStateHtml(
        ICONS.route,
        '还没有路由',
        '新建一条规则，决定某个收件地址的邮件转发到哪里',
      )}<button type="button" class="btn btn-primary btn-sm" data-add-prefix="">${ICONS.plus}新建规则</button>`);
      graph?.render(null);
      return;
    }

    showTable(stateEl(), listEl());
    listEl().innerHTML = routes.map(renderRoute).join('');
    renderGraph();
  }

  function renderRoute(route: Route) {
    const expanded = expandedPrefixes.has(route.prefix);
    const outlets = [...route.own, ...route.inherited];
    const chips = outlets.length
      ? outlets.map(renderChip).join('')
      : '<span class="route-chip is-archive">仅存档，未转发</span>';
    const failed = route.own.some((outlet) => outlet.enabled && outlet.delivery?.status === 'failed');
    const bodyId = `route-body-${encodeURIComponent(route.prefix).replace(/[^\w-]/g, '_')}`;
    return `
      <section class="route-row${route.wildcard ? ' is-wildcard' : ''}${failed ? ' has-failure' : ''}${expanded ? ' is-open' : ''}" data-prefix-group="${escapeHtml(route.prefix)}">
        <button type="button" class="route-head" data-route-toggle="${escapeHtml(route.prefix)}" aria-expanded="${expanded}" aria-controls="${bodyId}">
          <span class="route-source">
            <code class="route-address">${escapeHtml(addressOf(route.prefix))}</code>
            <span class="route-meta">${escapeHtml(routeMeta(route))}</span>
          </span>
          <span class="route-arrow" aria-hidden="true">→</span>
          <span class="route-chips">${chips}</span>
          <span class="route-caret" aria-hidden="true"></span>
        </button>
        <div class="route-body" id="${bodyId}" ${expanded ? '' : 'hidden'}>
          ${route.own.length ? `<div class="rule-group-list" role="list">${route.own.map((outlet) => renderRuleRow(byId.get(outlet.key)!, outlet)).join('')}</div>` : ''}
          ${route.inherited.length ? `<p class="route-note">另有 ${route.inherited.length} 个出口来自 <code>*</code> 规则，在「其他所有地址」中管理。</p>` : ''}
          ${route.wildcard ? '<p class="route-note">发往任何地址的邮件都会送到这里，同时也会送到该地址自己的出口。</p>' : ''}
          <button type="button" class="btn btn-sm route-add" data-add-prefix="${escapeHtml(route.prefix)}">${ICONS.plus}添加出口</button>
        </div>
      </section>`;
  }

  function renderDelivery(outlet: RouteOutlet) {
    if (!outlet?.delivery) return '<span class="rule-delivery is-idle">尚无投递记录</span>';
    const { status, at, error } = outlet.delivery;
    return `<span class="rule-delivery is-${escapeHtml(status)}" title="${escapeHtml(fullTime(at))}">
      ${escapeHtml(DELIVERY_TEXT[status] || status)} · ${escapeHtml(relTime(at))}${status === 'failed' && error ? `<small>${escapeHtml(error)}</small>` : ''}
    </span>`;
  }

  function renderTarget(rule: ChannelRule) {
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

  function renderRuleRow(rule: ChannelRule, outlet: RouteOutlet) {
      const key = keyOf(rule);
      const channel = CHANNELS[rule.channel];
      const testButton = rule.channel === 'tg' || rule.channel === 'bark'
        ? `<button class="icon-btn" data-test="${key}" title="发送测试消息" aria-label="发送测试消息">${ICONS.send}</button>`
        : '';
      return `
        <article class="rule-group-row${rule.enabled ? '' : ' is-disabled'}" data-id="${key}" role="listitem">
          <div class="rule-group-channel"><span class="channel-badge channel-${rule.channel}">${escapeHtml(channel.label)}</span></div>
          <div class="rule-group-target">${renderTarget(rule)}${renderDelivery(outlet)}</div>
          <div class="rule-group-status">
            <label class="switch">
              <input type="checkbox" data-toggle="${key}" ${rule.enabled ? 'checked' : ''} aria-label="${escapeHtml(channel.toggleLabel)}">
              <span class="switch-track"></span>
            </label>
            <span>${rule.enabled ? '已启用' : '已停用'}</span>
          </div>
          <div class="rule-actions">${testButton}<button class="icon-btn" data-edit="${key}" title="编辑规则" aria-label="编辑规则">${ICONS.edit}</button><button class="icon-btn danger" data-del="${key}" title="删除" aria-label="删除">${ICONS.trash}</button></div>
        </article>`;
  }

  function telegramErrorHelp(description: string) {
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

  function showTestError(error: unknown, rule: ChannelRule) {
    const telegram = errorDetails(error)?.telegram;
    const description = telegram?.description || errorMessage(error);
    const errorCode = telegram?.error_code ?? '—';
    const status = error instanceof ApiError ? error.status : undefined;
    const httpStatus = telegram?.http_status ?? status ?? '—';
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
    $('[data-act="copy-error"]', overlay).addEventListener('click', () => {
      copyText(copyValue, '错误详情');
    });
  }

  const CHANNEL_HINTS = {
    forward: '发往 <code>前缀@你的域名</code> 的邮件会通过「设置 → 邮件发送」中配置的服务转发到目标邮箱，目标邮箱无需逐个验证。同一前缀可添加多个出口。',
    tg: '匹配前缀的邮件将推送到对应 Telegram 会话。个人会话为正数 ID，群组/频道为 <code>-100</code> 开头的负数 ID，可通过 <code>@userinfobot</code> 获取。',
    bark: '匹配前缀的邮件将推送到选定 Bark 设备。支持 Bark 官方服务及使用 HTTPS 的自建服务。',
  };

  // Every channel's fields are rendered and the inactive ones hidden, so the
  // channel select can switch without rebuilding the form. The select ids are
  // the ones app.ts's catalog loaders refresh, which keeps the options current
  // when a destination is added from inside the modal.
  function ruleFieldsHtml(values: RuleFormValues) {
    return `
      <div class="rule-channel-fields" data-channel-fields="forward">
        <div class="field">
          <label class="field-label" for="rule-target">邮件目标</label>
          <div class="rule-bot-picker">
            <select id="rule-target" name="destination_id" required>${emailDestinationOptions(values.destination_id)}</select>
            <button type="button" class="btn btn-sm" data-add-destination="forward">${ICONS.plus}添加目标</button>
          </div>
        </div>
      </div>
      <div class="rule-channel-fields" data-channel-fields="bark">
        <div class="field">
          <label class="field-label" for="rule-bark">Bark 目标</label>
          <div class="rule-bot-picker">
            <select id="rule-bark" name="endpoint_id" required>${barkEndpointOptions(values.endpoint_id)}</select>
            <button type="button" class="btn btn-sm" data-add-destination="bark">${ICONS.plus}添加目标</button>
          </div>
        </div>
      </div>
      <div class="rule-channel-fields" data-channel-fields="tg">
        <div class="field">
          <label class="field-label" for="rule-chat">Chat ID</label>
          <input id="rule-chat" name="chat_id" type="text" value="${escapeHtml(values.chat_id ?? '')}" placeholder="-1001234567890" autocomplete="off" spellcheck="false" required>
        </div>
        <div class="field">
          <label class="field-label" for="rule-bot">发送 Bot</label>
          <div class="rule-bot-picker">
            <select id="rule-bot" name="bot_id" required>${telegramBotOptions(values.bot_id)}</select>
            <button type="button" class="btn btn-sm" data-add-destination="tg">${ICONS.plus}添加目标</button>
          </div>
        </div>
      </div>`;
  }

  function setChannel(form: HTMLFormElement, channelName: string) {
    const channel = isChannelKey(channelName) ? channelName : 'forward';
    form.querySelectorAll<HTMLElement>('[data-channel-fields]').forEach((container) => {
      const active = container.dataset.channelFields === channel;
      container.hidden = !active;
      container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach((control) => {
        control.disabled = !active || ruleCatalogEmpty(control.id);
      });
    });
    form.querySelectorAll<HTMLElement>('[data-channel-hint]').forEach((hint) => {
      hint.hidden = hint.dataset.channelHint !== channel;
    });
  }

  function rulePayload(channelName: ChannelKey, data: Record<string, string>): RulePayload {
    if (channelName === 'forward') return { prefix: data.prefix, destination_id: data.destination_id };
    if (channelName === 'tg') return { prefix: data.prefix, chat_id: data.chat_id, bot_id: data.bot_id };
    return { prefix: data.prefix, endpoint_id: data.endpoint_id };
  }

  const ADD_DESTINATION = {
    forward: { open: openEmailDestinationCreateModal, reload: loadDestinationCatalogs, select: '#rule-target' },
    bark: { open: openBarkDestinationCreateModal, reload: loadDestinationCatalogs, select: '#rule-bark' },
    tg: { open: openTelegramBotCreateModal, reload: loadTelegramBotCatalog, select: '#rule-bot' },
  };

  // One modal both creates and edits a rule.
  // - rule: edit it. Its channel is fixed, because each channel is its own table.
  // - prefix / preset: prefill a new rule, e.g. from a graph node. preset picks
  //   the channel and outlet: { channel, destination_id | endpoint_id | chat_id + bot_id }.
  function openRuleModal({ rule = null, prefix = '', preset = null }: RuleModalOptions = {}) {
    const values: RuleFormValues = rule || preset || {};
    const initialChannel = values.channel || 'forward';
    const overlay = openModal(`
      <form class="rule-form" novalidate>
        <div class="modal-header">
          <h3 class="modal-title">${escapeHtml(rule ? CHANNELS[rule.channel].editTitle : '新建规则')}</h3>
          <button type="button" class="icon-btn" data-act="close" title="关闭" aria-label="关闭">${ICONS.close}</button>
        </div>
        <div class="modal-body edit-rule-fields">
          <div class="field">
            <label class="field-label" for="rule-channel">投递渠道</label>
            <select id="rule-channel" name="channel"${rule ? ' disabled' : ''}>
              <option value="forward">转发邮箱</option>
              <option value="tg">Telegram</option>
              <option value="bark">Bark</option>
            </select>
          </div>
          <div class="field">
            <label class="field-label" for="rule-prefix">收件前缀</label>
            <input id="rule-prefix" name="prefix" type="text" value="${escapeHtml(rule ? rule.prefix : prefix)}" placeholder="github" autocomplete="off" spellcheck="false" required>
          </div>
          ${ruleFieldsHtml(values)}
          <p class="form-hint">${Object.entries(CHANNEL_HINTS)
            .map(([channel, hint]) => `<span data-channel-hint="${channel}">${hint}</span>`).join('')}</p>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" data-act="close">取消</button>
          <button type="submit" class="btn btn-primary">${rule ? '保存修改' : '添加规则'}</button>
        </div>
      </form>
    `, { small: true });

    const form = $<HTMLFormElement>('.rule-form', overlay);
    const channelSelect = $<HTMLSelectElement>('#rule-channel', form);
    channelSelect.value = initialChannel;
    setChannel(form, initialChannel);
    channelSelect.addEventListener('change', () => setChannel(form, channelSelect.value));

    overlay.querySelectorAll('[data-act="close"]').forEach((button) => {
      button.addEventListener('click', closeModal);
    });
    form.addEventListener('click', (event) => {
      const button = (event.target as Element).closest<HTMLElement>('[data-add-destination]');
      if (!button) return;
      // ruleFieldsHtml renders these buttons with a channel key each.
      const { open, reload, select } = ADD_DESTINATION[button.dataset.addDestination as ChannelKey];
      open({
        onCreated: async (created) => {
          await reload();
          const control = $<HTMLSelectElement>(select, form);
          control.value = String(created.id);
          loadedTabs.delete('destinations');
          control.focus();
        },
      });
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      // The select only offers the three channel keys.
      const channelName = channelSelect.value as ChannelKey;
      const channel = CHANNELS[channelName];
      const data = Object.fromEntries(
        [...new FormData(form)].map(([key, value]) => [key, String(value).trim()] as const)
      );
      const payload = rulePayload(channelName, data);
      const problem = channel.validate(payload);
      if (problem) {
        toast(problem, 'error');
        return;
      }

      const button = $<HTMLButtonElement>('button[type="submit"]', form);
      button.disabled = true;
      try {
        if (rule) {
          await api(`${channel.endpoint}/${rule.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        } else {
          await api(channel.endpoint, { method: 'POST', body: JSON.stringify(payload) });
          // Open the route the outlet was added to, so the result is visible.
          expandedPrefixes.add(payload.prefix.toLowerCase());
        }
        closeModal();
        toast(rule ? '规则已更新' : '规则已添加', 'success');
        await load();
        if (!rule) {
          $(`[data-prefix-group="${CSS.escape(payload.prefix.toLowerCase())}"]`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      } catch (error) {
        if (!isUnauthorized(error)) toast(`${rule ? '保存' : '添加'}失败：${errorMessage(error)}`, 'error');
      } finally {
        button.disabled = false;
      }
    });

    // Focus the first field the customer still has to fill.
    $(prefix && !preset ? '#rule-channel' : '#rule-prefix', form).focus();
  }

  function toggleRoute(button: HTMLElement) {
    const prefix = button.dataset.routeToggle ?? '';
    // renderRoute puts every toggle inside its row, next to the row's body.
    const row = button.closest<HTMLElement>('.route-row')!;
    const body = $('.route-body', row);
    const open = body.hidden;
    body.hidden = !open;
    row.classList.toggle('is-open', open);
    button.setAttribute('aria-expanded', String(open));
    if (open) expandedPrefixes.add(prefix);
    else expandedPrefixes.delete(prefix);
  }

  function init() {
    graph = mountRoutingGraph($('#rules-graph'), {
      onEdge: (ruleKey) => {
        const rule = byId.get(ruleKey);
        if (rule) openRuleModal({ rule });
      },
      onSource: (prefix) => openRuleModal({ prefix }),
      onUnrouted: (prefix) => openRuleModal({ prefix }),
      onOutlet: (outlet) => openRuleModal({ preset: outlet.preset }),
    });
    document.querySelectorAll<HTMLElement>('[data-routes-view]').forEach((button) => {
      button.addEventListener('click', () => setView(button.dataset.routesView));
    });
    setView(localStorage.getItem(ROUTES_VIEW_KEY));
    $('#rules-compose-toggle').addEventListener('click', () => openRuleModal());

    stateEl().addEventListener('click', (event) => {
      const target = event.target as Element;
      if (target.closest('[data-retry]')) load();
      if (target.closest('[data-add-prefix]')) openRuleModal();
    });

    listEl().addEventListener('change', async (event) => {
      const toggle = (event.target as Element).closest<HTMLInputElement>('[data-toggle]');
      if (!toggle) return;
      const rule = byId.get(toggle.dataset.toggle ?? '');
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
        if (!isUnauthorized(error)) toast(`操作失败：${errorMessage(error)}`, 'error');
      } finally {
        toggle.disabled = false;
      }
    });

    listEl().addEventListener('click', async (event) => {
      const target = event.target as Element;
      const routeToggle = target.closest<HTMLElement>('[data-route-toggle]');
      if (routeToggle) {
        toggleRoute(routeToggle);
        return;
      }

      const addButton = target.closest<HTMLElement>('[data-add-prefix]');
      if (addButton) {
        openRuleModal({ prefix: addButton.dataset.addPrefix });
        return;
      }

      const testButton = target.closest<HTMLButtonElement>('[data-test]');
      if (testButton) {
        const rule = byId.get(testButton.dataset.test ?? '');
        if (!rule || (rule.channel !== 'tg' && rule.channel !== 'bark') || testButton.disabled) return;
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
          if (!isUnauthorized(error)) {
            if (rule.channel === 'tg') showTestError(error, rule);
            else toast(`Bark 测试失败：${errorDetails(error)?.bark?.description || errorMessage(error)}`, 'error');
          }
        } finally {
          testButton.disabled = false;
          testButton.removeAttribute('aria-busy');
          testButton.innerHTML = original;
        }
        return;
      }

      const editButton = target.closest<HTMLElement>('[data-edit]');
      if (editButton) {
        const rule = byId.get(editButton.dataset.edit ?? '');
        if (rule) openRuleModal({ rule });
        return;
      }

      const deleteButton = target.closest<HTMLElement>('[data-del]');
      if (!deleteButton) return;
      const rule = byId.get(deleteButton.dataset.del ?? '');
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
        if (!isUnauthorized(error)) toast(`删除失败：${errorMessage(error)}`, 'error');
      }
    });
  }

  return { load, init };
})();

export { rulesView };
