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
import { logProcess, isDuplicate, saveMailRecord } from "./observability/log";
import { resolveRouteTargets } from "./routing/rules";
import { formatTelegramMessage } from "./telegram/format";
import { multicastTelegram } from "./telegram/send";

interface ProcessOptions {
  skipForward?: boolean;
}

interface ProcessResult {
  messageId: string;
  routeKey: string;
  tgTargets: string[];
  aiStatus: "skipped" | "ok" | "failed";
  forwardStatus: "ok" | "partial" | "failed";
  errors: string[];
}

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

async function processIncomingEmail(
  message: ForwardableEmailMessage,
  env: Env,
  options: ProcessOptions = {}
): Promise<ProcessResult | { skipped: true; messageId: string }> {
  const routeConfig = await loadRouteConfig(env);
  const parsed = await parseMail(message);
  const errors: string[] = [];

  if (await isDuplicate(env.DB, parsed.messageId)) {
    console.log(`skip duplicated message: ${parsed.messageId}`);
    return { skipped: true, messageId: parsed.messageId };
  }

  const routeTargets = resolveRouteTargets(parsed.to, routeConfig);
  let forwardStatus: "ok" | "partial" | "failed" = "ok";

  if (!options.skipForward) {
    const forwardTargets = buildForwardTargets(env.DEFAULT_FORWARD_EMAIL, routeTargets.emails);
    const forwardResults = await forwardRawEmail(message, forwardTargets);
    const forwardOkCount = forwardResults.filter((item) => item.ok).length;
    forwardStatus =
      forwardOkCount === forwardResults.length
        ? "ok"
        : forwardOkCount === 0
          ? "failed"
          : "partial";
  }

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

  const processResult: ProcessResult = {
    messageId: parsed.messageId,
    routeKey: routeTargets.routeKey,
    tgTargets: routeTargets.telegramChats,
    aiStatus,
    forwardStatus,
    errors
  };

  logProcess(processResult);

  await saveMailRecord(env.DB, {
    messageId: parsed.messageId,
    from: parsed.from,
    to: parsed.to,
    subject: parsed.subject,
    bodyText: parsed.text,
    rawEmail: parsed.raw,
    routeKey: routeTargets.routeKey,
    forwardStatus: processResult.forwardStatus,
    aiStatus: processResult.aiStatus
  });

  return processResult;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await processIncomingEmail(message, env);
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
    if (url.pathname === "/debug/trigger-email") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "method not allowed" }, 405);
      }
      if (!hasAdminPermission(request, env)) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      let payload: { to?: string; from?: string; subject?: string; text?: string; skipForward?: boolean };
      try {
        payload = (await request.json()) as {
          to?: string;
          from?: string;
          subject?: string;
          text?: string;
          skipForward?: boolean;
        };
      } catch {
        return jsonResponse({ error: "invalid json body" }, 400);
      }
      if (!payload.to) {
        return jsonResponse({ error: "field 'to' is required" }, 400);
      }

      const mockFrom = payload.from ?? "debug@local.test";
      const mockSubject = payload.subject ?? "Debug Trigger Mail";
      const mockText = payload.text ?? "This is a debug-triggered email flow.";
      const messageId = `<debug-${crypto.randomUUID()}@local.test>`;
      const rawMail = [
        `From: ${mockFrom}`,
        `To: ${payload.to}`,
        `Subject: ${mockSubject}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-Id: ${messageId}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        mockText
      ].join("\r\n");

      const mockMessage = {
        from: mockFrom,
        to: payload.to,
        headers: new Headers({
          from: mockFrom,
          to: payload.to,
          subject: mockSubject,
          date: new Date().toUTCString(),
          "message-id": messageId
        }),
        raw: new TextEncoder().encode(rawMail),
        forward: async () => Promise.resolve()
      } as unknown as ForwardableEmailMessage;

      const result = await processIncomingEmail(mockMessage, env, {
        skipForward: payload.skipForward ?? true
      });
      return jsonResponse({ ok: true, debug: true, result });
    }
    return new Response("Not Found", { status: 404 });
  }
};
