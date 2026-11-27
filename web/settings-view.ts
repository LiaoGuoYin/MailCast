import type { SenderTestResponse, SettingsResponse, TelegramBot } from './api-types.js';
import { $, ICONS, api, barkEndpoints, closeModal, confirmDialog, emailDestinations, errorDetails } from './app.js';
import { errorMessage, escapeHtml, formControl, isUnauthorized, loadDestinationCatalogs, loadTelegramBotCatalog } from './app.js';
import { loadedTabs, openModal, telegramErrorMessage, telegramBots, toast } from './app.js';

// ── Settings view ──

// An email destination or a Bark endpoint: the edit modal reads the fields of
// whichever kind it was opened for.
interface EditableDestination {
  id: number;
  name: string;
  email_address?: string;
  key_hint?: string;
  server_url?: string;
}

const settingsView = (() => {
  let resendConfigured = false;
  const MODEL_PLACEHOLDER: Record<string, string> = {
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

  function openDestinationEdit(kind: 'email' | 'bark', item: EditableDestination) {
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
    const form = $<HTMLFormElement>('form', overlay);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, String(value).trim()] as const));
      const button = $<HTMLButtonElement>('button[type="submit"]', form);
      button.disabled = true;
      try {
        await api(`/destinations/${isEmail ? 'emails' : 'bark'}/${item.id}`, { method: 'PUT', body: JSON.stringify(data) });
        closeModal();
        await refreshDestinations();
        loadedTabs.delete('rules');
        toast('目标已更新', 'success');
      } catch (error) {
        if (!isUnauthorized(error)) toast(`保存失败：${errorMessage(error)}`, 'error');
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

  function openTelegramBotEdit(bot: TelegramBot) {
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
    const form = $<HTMLFormElement>('.edit-telegram-bot-form', overlay);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = formControl(form, 'name').value.trim();
      const token = formControl(form, 'token').value.trim();
      if (!name) {
        toast('请填写 Bot 名称', 'error');
        return;
      }
      const button = $<HTMLButtonElement>('button[type="submit"]', form);
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
        if (!isUnauthorized(error)) toast(`保存失败：${telegramErrorMessage(error)}`, 'error');
      } finally {
        button.disabled = false;
        button.textContent = '验证并保存';
      }
    });
    $('#edit-bot-name', overlay).focus();
  }

  function syncAiFields() {
    const provider = $<HTMLSelectElement>('#ai-provider').value;
    const visible: Record<string, boolean> = {
      model: provider !== 'none',
      base_url: provider === 'openai',
      api_key: provider === 'openai',
    };
    document.querySelectorAll<HTMLElement>('[data-ai-field]').forEach((el) => {
      el.hidden = !visible[el.dataset.aiField ?? ''];
    });
    if (provider !== 'none') {
      $<HTMLInputElement>('#ai-model').placeholder = MODEL_PLACEHOLDER[provider];
    }
  }

  function syncEmailSenderFields() {
    const provider = $<HTMLSelectElement>('#email-provider').value;
    document.querySelectorAll<HTMLElement>('[data-email-provider-field]').forEach((el) => {
      el.hidden = el.dataset.emailProviderField !== provider;
    });
  }

  async function load() {
    try {
      const [{ ai, email_sender: emailSender }] = await Promise.all([
        api<SettingsResponse>('/settings'),
        refreshTelegramBots(),
        refreshDestinations(),
      ]);
      resendConfigured = Boolean(emailSender.resend_configured);
      $<HTMLSelectElement>('#email-provider').value = emailSender.provider || 'resend';
      $<HTMLInputElement>('#email-from-address').value = emailSender.configured_address || '';
      $<HTMLInputElement>('#resend-api-key').value = '';
      $<HTMLInputElement>('#resend-api-key').placeholder = resendConfigured
        ? `已配置 ${emailSender.resend_key_hint}；留空保持不变`
        : 're_...';
      $('#resend-key-status').textContent = resendConfigured
        ? `当前已配置 ${emailSender.resend_key_hint}，完整 Key 不会回显。`
        : '尚未配置。建议使用限制为发送权限和指定域名的 API Key。';
      $<HTMLInputElement>('#resend-key-clear').checked = false;
      $('#resend-key-clear-label').hidden = !resendConfigured;
      const sourceLabels = {
        web: '当前使用网页配置',
        environment: `当前使用环境变量：${emailSender.environment_address}`,
        automatic: '当前按每封邮件的收件域名自动生成',
      };
      $('#cloudflare-email-status').textContent = emailSender.binding_configured
        ? 'EMAIL binding 已连接。'
        : '尚未连接 EMAIL binding；选择后邮件转发会失败。向任意目标发信需要 Workers Paid。';
      $('#email-sender-status').textContent = `${sourceLabels[emailSender.source]}。发件域名必须已在所选服务中验证。`;
      $<HTMLSelectElement>('#ai-provider').value = ai.provider || 'none';
      $<HTMLInputElement>('#ai-model').value = ai.model || '';
      $<HTMLInputElement>('#ai-base').value = ai.base_url || '';
      $<HTMLInputElement>('#ai-key').value = ai.api_key || '';
      syncEmailSenderFields();
      syncAiFields();
    } catch (err) {
      if (!isUnauthorized(err)) toast(`加载设置失败：${errorMessage(err)}`, 'error');
    }
  }

  // Sends through the saved configuration, the same path a forward rule uses,
  // so a green result here means forwarding will work.
  function openSenderTest() {
    const suggested = emailDestinations[0]?.email_address || '';
    const overlay = openModal(`
      <form id="sender-test-form" novalidate>
        <div class="modal-header"><h3 class="modal-title">发送测试邮件</h3></div>
        <div class="modal-body">
          <div class="field">
            <label class="field-label" for="sender-test-to">收件邮箱</label>
            <input id="sender-test-to" type="email" value="${escapeHtml(suggested)}" placeholder="you@example.com" autocomplete="email" required>
            <small class="field-help">使用已保存的设置发送。刚修改过设置的话，请先保存再测试。</small>
          </div>
          <p id="sender-test-result" class="field-help" role="status" hidden></p>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" data-act="cancel">关闭</button>
          <button type="submit" class="btn btn-primary">发送</button>
        </div>
      </form>
    `, { small: true });
    const input = $<HTMLInputElement>('#sender-test-to', overlay);
    const result = $('#sender-test-result', overlay);
    $('[data-act="cancel"]', overlay).addEventListener('click', closeModal);
    $('form', overlay).addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!input.checkValidity()) {
        input.reportValidity();
        return;
      }
      const button = $<HTMLButtonElement>('button[type="submit"]', event.target as HTMLFormElement);
      button.disabled = true;
      result.hidden = true;
      try {
        const data = await api<SenderTestResponse>('/settings/email-sender/test', {
          method: 'POST',
          body: JSON.stringify({ to: input.value.trim() }),
        });
        result.className = 'field-help is-success';
        result.textContent = `已从 ${data.from_address} 发出，请检查收件箱（也可能在垃圾邮件中）。`;
        result.hidden = false;
      } catch (error) {
        if (isUnauthorized(error)) return;
        result.className = 'field-help is-error';
        result.textContent = errorMessage(error);
        result.hidden = false;
      } finally {
        button.disabled = false;
      }
    });
    input.focus();
    input.select();
  }

  function init() {
    $('#email-sender-test').addEventListener('click', openSenderTest);
    $<HTMLSelectElement>('#ai-provider').addEventListener('change', syncAiFields);
    $<HTMLSelectElement>('#email-provider').addEventListener('change', syncEmailSenderFields);
    $<HTMLInputElement>('#resend-key-clear').addEventListener('change', (event) => {
      $<HTMLInputElement>('#resend-api-key').disabled = (event.target as HTMLInputElement).checked;
    });

    $('#email-sender-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const provider = $<HTMLSelectElement>('#email-provider').value;
      const fromAddress = $<HTMLInputElement>('#email-from-address').value.trim();
      const resendApiKey = provider === 'resend' ? $<HTMLInputElement>('#resend-api-key').value.trim() : '';
      const clearResendApiKey = provider === 'resend' && $<HTMLInputElement>('#resend-key-clear').checked;
      if (fromAddress && !$<HTMLInputElement>('#email-from-address').checkValidity()) {
        $<HTMLInputElement>('#email-from-address').reportValidity();
        return;
      }
      const button = $<HTMLButtonElement>('button[type="submit"]', event.target as HTMLFormElement);
      button.disabled = true;
      try {
        await api('/settings/email-sender', {
          method: 'PUT',
          body: JSON.stringify({
            provider,
            from_address: fromAddress,
            resend_api_key: resendApiKey,
            clear_resend_api_key: clearResendApiKey,
          }),
        });
        $<HTMLInputElement>('#resend-api-key').disabled = false;
        await load();
        loadedTabs.delete('rules');
        toast('邮件发送设置已保存', 'success');
      } catch (error) {
        if (!isUnauthorized(error)) toast(`保存失败：${errorMessage(error)}`, 'error');
      } finally {
        button.disabled = false;
      }
    });

    $('#telegram-bot-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      const name = $<HTMLInputElement>('#telegram-bot-name').value.trim();
      const token = $<HTMLInputElement>('#telegram-bot-token').value.trim();
      if (!name || !token) {
        toast('请填写 Bot 名称和 Token', 'error');
        return;
      }

      const button = $<HTMLButtonElement>('button[type="submit"]', form);
      button.disabled = true;
      button.innerHTML = '<span class="spinner" aria-hidden="true"></span>验证中…';
      try {
        await api('/settings/telegram-bots', {
          method: 'POST',
          body: JSON.stringify({ name, token }),
        });
        form.reset();
        await refreshTelegramBots();
        toast('Bot 已验证并添加', 'success');
      } catch (error) {
        if (!isUnauthorized(error)) toast(`添加失败：${telegramErrorMessage(error)}`, 'error');
      } finally {
        button.disabled = false;
        button.textContent = '验证并添加';
      }
    });

    $('#telegram-bots-list').addEventListener('click', async (event) => {
      const target = event.target as Element;
      const editButton = target.closest<HTMLElement>('[data-edit-bot]');
      if (editButton) {
        const bot = telegramBots.find((item) => String(item.id) === editButton.dataset.editBot);
        if (bot) openTelegramBotEdit(bot);
        return;
      }

      const testButton = target.closest<HTMLButtonElement>('[data-test-bot]');
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
          if (!isUnauthorized(error)) toast(`验证失败：${telegramErrorMessage(error)}`, 'error');
        }
        return;
      }

      const deleteButton = target.closest<HTMLButtonElement>('[data-delete-bot]');
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
        if (!isUnauthorized(error)) toast(`删除失败：${errorMessage(error)}`, 'error');
      }
    });

    $('#email-destination-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      const payload = {
        name: $<HTMLInputElement>('#email-destination-name').value.trim(),
        email_address: $<HTMLInputElement>('#email-destination-address').value.trim(),
      };
      const button = $<HTMLButtonElement>('button[type="submit"]', form);
      button.disabled = true;
      try {
        await api('/destinations/emails', { method: 'POST', body: JSON.stringify(payload) });
        form.reset();
        await refreshDestinations();
        loadedTabs.delete('rules');
        toast('邮件目标已添加', 'success');
      } catch (error) {
        if (!isUnauthorized(error)) toast(`添加失败：${errorMessage(error)}`, 'error');
      } finally { button.disabled = false; }
    });

    $('#email-destinations-list').addEventListener('click', async (event) => {
      const target = event.target as Element;
      const edit = target.closest<HTMLElement>('[data-edit-email-target]');
      if (edit) {
        const item = emailDestinations.find((target) => String(target.id) === edit.dataset.editEmailTarget);
        if (item) openDestinationEdit('email', item);
        return;
      }
      const remove = target.closest<HTMLButtonElement>('[data-delete-email-target]');
      if (!remove || remove.disabled) return;
      const item = emailDestinations.find((target) => String(target.id) === remove.dataset.deleteEmailTarget);
      if (!item || !await confirmDialog({ title: '删除邮件目标', message: `确定删除“${item.name}”吗？` })) return;
      try {
        await api(`/destinations/emails/${item.id}`, { method: 'DELETE' });
        await refreshDestinations();
        loadedTabs.delete('rules');
        toast('邮件目标已删除', 'success');
      } catch (error) { if (!isUnauthorized(error)) toast(`删除失败：${errorMessage(error)}`, 'error'); }
    });

    $('#bark-endpoint-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      const payload = {
        name: $<HTMLInputElement>('#bark-endpoint-name').value.trim(),
        server_url: $<HTMLInputElement>('#bark-server-url').value.trim(),
        device_key: $<HTMLInputElement>('#bark-device-key').value.trim(),
      };
      const button = $<HTMLButtonElement>('button[type="submit"]', form);
      button.disabled = true;
      try {
        await api('/destinations/bark', { method: 'POST', body: JSON.stringify(payload) });
        form.reset();
        $<HTMLInputElement>('#bark-server-url').value = 'https://api.day.app';
        await refreshDestinations();
        loadedTabs.delete('rules');
        toast('Bark 目标已添加，可点击测试验证', 'success');
      } catch (error) { if (!isUnauthorized(error)) toast(`添加失败：${errorMessage(error)}`, 'error'); }
      finally { button.disabled = false; }
    });

    $('#bark-endpoints-list').addEventListener('click', async (event) => {
      const target = event.target as Element;
      const test = target.closest<HTMLButtonElement>('[data-test-bark]');
      if (test && !test.disabled) {
        const item = barkEndpoints.find((target) => String(target.id) === test.dataset.testBark);
        if (!item) return;
        test.disabled = true;
        try {
          await api(`/destinations/bark/${item.id}/test`, { method: 'POST' });
          toast(`已向 ${item.name} 发送测试通知`, 'success');
        } catch (error) {
          if (!isUnauthorized(error)) toast(`测试失败：${errorDetails(error)?.bark?.description || errorMessage(error)}`, 'error');
        } finally { test.disabled = false; }
        return;
      }
      const edit = target.closest<HTMLElement>('[data-edit-bark]');
      if (edit) {
        const item = barkEndpoints.find((target) => String(target.id) === edit.dataset.editBark);
        if (item) openDestinationEdit('bark', item);
        return;
      }
      const remove = target.closest<HTMLButtonElement>('[data-delete-bark]');
      if (!remove || remove.disabled) return;
      const item = barkEndpoints.find((target) => String(target.id) === remove.dataset.deleteBark);
      if (!item || !await confirmDialog({ title: '删除 Bark 目标', message: `确定删除“${item.name}”吗？` })) return;
      try {
        await api(`/destinations/bark/${item.id}`, { method: 'DELETE' });
        await refreshDestinations();
        loadedTabs.delete('rules');
        toast('Bark 目标已删除', 'success');
      } catch (error) { if (!isUnauthorized(error)) toast(`删除失败：${errorMessage(error)}`, 'error'); }
    });

    $('#ai-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const provider = $<HTMLSelectElement>('#ai-provider').value;
      const payload = {
        provider,
        model: $<HTMLInputElement>('#ai-model').value.trim(),
        base_url: $<HTMLInputElement>('#ai-base').value.trim(),
        api_key: $<HTMLInputElement>('#ai-key').value.trim(),
      };

      if (provider === 'openai' && !payload.api_key) {
        toast('OpenAI 兼容接口需要填写 API Key', 'error');
        return;
      }
      if (payload.base_url && !/^https?:\/\//.test(payload.base_url)) {
        toast('API Base URL 需以 http(s):// 开头', 'error');
        return;
      }

      const btn = $<HTMLButtonElement>('button[type="submit"]', e.target as HTMLFormElement);
      btn.disabled = true;
      try {
        await api('/settings/ai', { method: 'PUT', body: JSON.stringify(payload) });
        toast('模型配置已保存', 'success');
      } catch (err) {
        if (!isUnauthorized(err)) toast(`保存失败：${errorMessage(err)}`, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  return { load, init };
})();

export { settingsView };
