export interface TelegramSendResult {
  chatId: string;
  ok: boolean;
  reason?: string;
}

async function sendWithTimeout(url: string, body: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  timeoutMs = 4500
): Promise<TelegramSendResult> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = JSON.stringify({
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  });

  try {
    const response = await sendWithTimeout(url, payload, timeoutMs);
    if (!response.ok) {
      return { chatId, ok: false, reason: `http:${response.status}` };
    }
    return { chatId, ok: true };
  } catch (error) {
    return {
      chatId,
      ok: false,
      reason: error instanceof Error ? error.message : "unknown error"
    };
  }
}

export async function multicastTelegram(
  botToken: string,
  chatIds: string[],
  text: string
): Promise<TelegramSendResult[]> {
  const unique = [...new Set(chatIds)];
  return Promise.all(unique.map((chatId) => sendTelegramMessage(botToken, chatId, text)));
}
