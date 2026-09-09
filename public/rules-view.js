import { $, CHANNELS, ICONS, api, barkEndpointOptions, closeModal, confirmDialog, copyText } from './app.js';
import { emailDestinationOptions, emptyStateHtml, errorStateHtml, escapeHtml, loadDestinationCatalogs } from './app.js';
import { loadTelegramBotCatalog, loadedTabs, openBarkDestinationCreateModal } from './app.js';
import { openEmailDestinationCreateModal, openModal, openTelegramBotCreateModal, parseDate, relTime } from './app.js';
import { ruleCatalogEmpty, showState, showTable, telegramBotOptions, toast } from './app.js';

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
        control.disabled = !active || ruleCatalogEmpty(control.id);
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

export { rulesView };
