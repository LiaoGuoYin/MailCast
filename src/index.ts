import { extractSignalFromMail } from "./ai/extract";
import {
  getAiTimeoutMs,
  isAiEnabled,
  loadRouteConfig,
  parseRouteConfig,
  saveRouteConfig,
  type Env
} from "./config";
import { buildForwardTargets, forwardRawEmail } from "./mail/forward";
import { parseMail } from "./mail/parser";
import { logProcess, isDuplicate } from "./observability/log";
import { resolveRouteTargets } from "./routing/rules";
import { formatTelegramMessage } from "./telegram/format";
import { multicastTelegram } from "./telegram/send";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function renderAdminHtml(cfg: unknown): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Coin Mail Router Admin</title>
    <style>
      body { font-family: sans-serif; margin: 2rem auto; max-width: 860px; line-height: 1.5; }
      pre { background: #f4f4f4; padding: 1rem; overflow: auto; }
      .ok { color: #1a7f37; }
    </style>
  </head>
  <body>
    <h1>Coin Mail Router</h1>
    <p class="ok">Worker is running.</p>
    <h2>Current route config</h2>
    <pre>${JSON.stringify(cfg, null, 2)}</pre>
  </body>
</html>`;
}

function hasAdminPermission(request: Request, env: Env): boolean {
  const token = env.ADMIN_API_TOKEN;
  if (!token) return false;
  const auth = request.headers.get("authorization") ?? "";
  return auth === `Bearer ${token}`;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const routeConfig = await loadRouteConfig(env);
    const parsed = await parseMail(message);
    const errors: string[] = [];

    if (await isDuplicate(env.MAIL_CACHE, parsed.messageId)) {
      console.log(`skip duplicated message: ${parsed.messageId}`);
      return;
    }

    const routeTargets = resolveRouteTargets(parsed.to, routeConfig);
    const forwardTargets = buildForwardTargets(env.DEFAULT_FORWARD_EMAIL, routeTargets.emails);
    const forwardResults = await forwardRawEmail(message, forwardTargets);
    const forwardOkCount = forwardResults.filter((item) => item.ok).length;

    let aiStatus: "skipped" | "ok" | "failed" = "skipped";
    let signal = undefined;
    if (isAiEnabled(env)) {
      try {
        signal = await extractSignalFromMail(env.AI, env, parsed.text, getAiTimeoutMs(env));
        aiStatus = "ok";
      } catch (error) {
        aiStatus = "failed";
        errors.push(error instanceof Error ? error.message : "AI extract failed");
      }
    }

    const tgText = formatTelegramMessage(parsed, signal);
    const tgResults = await multicastTelegram(env.TELEGRAM_BOT_TOKEN, routeTargets.telegramChats, tgText);
    for (const result of tgResults) {
      if (!result.ok) errors.push(`tg:${result.chatId}:${result.reason ?? "failed"}`);
    }

    const forwardStatus =
      forwardOkCount === forwardResults.length
        ? "ok"
        : forwardOkCount === 0
          ? "failed"
          : "partial";

    logProcess({
      messageId: parsed.messageId,
      routeKey: routeTargets.routeKey,
      tgTargets: routeTargets.telegramChats,
      aiStatus,
      forwardStatus,
      errors
    });
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return jsonResponse({ ok: true, now: new Date().toISOString() });
    }
    if (url.pathname === "/admin") {
      const cfg = await loadRouteConfig(env);
      return new Response(renderAdminHtml(cfg), {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }
    if (url.pathname === "/routes") {
      if (request.method === "GET") {
        const cfg = await loadRouteConfig(env);
        return jsonResponse(cfg);
      }
      if (request.method === "PUT") {
        if (!hasAdminPermission(request, env)) {
          return jsonResponse({ error: "unauthorized" }, 401);
        }
        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return jsonResponse({ error: "invalid json body" }, 400);
        }
        const serialized = JSON.stringify(payload);
        const parsed = parseRouteConfig(serialized);
        await saveRouteConfig(env, parsed);
        return jsonResponse({ ok: true, routes: parsed.routes.length });
      }
      return jsonResponse({ error: "method not allowed" }, 405);
    }
    return new Response("Not Found", { status: 404 });
  }
};
