export interface RouteRule {
  prefix: string;
  telegramChats: string[];
  emails: string[];
}

export interface RouteConfig {
  default: {
    telegramChats: string[];
    emails: string[];
  };
  routes: RouteRule[];
}

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  DEFAULT_FORWARD_EMAIL: string;
  ADMIN_API_TOKEN?: string;
  ENABLE_AI_EXTRACT?: string;
  AI_MODEL_NAME?: string;
  AI_TIMEOUT_MS?: string;
  APP_VERSION?: string;
  DB: D1Database;
  AI: Ai;
}

const FALLBACK_ROUTE_CONFIG: RouteConfig = {
  default: {
    telegramChats: [],
    emails: []
  },
  routes: []
};

const DEFAULT_PREFIX = "*";

interface RouteRuleRow {
  prefix: string;
  telegram_chats: string;
  emails: string;
}

function parseJsonArray(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Build RouteConfig from D1 rows
function rowsToRouteConfig(rows: RouteRuleRow[]): RouteConfig {
  const config: RouteConfig = {
    default: { telegramChats: [], emails: [] },
    routes: []
  };
  for (const row of rows) {
    const chats = parseJsonArray(row.telegram_chats);
    const emails = parseJsonArray(row.emails);
    if (row.prefix === DEFAULT_PREFIX) {
      config.default = { telegramChats: chats, emails };
    } else {
      config.routes.push({ prefix: row.prefix, telegramChats: chats, emails });
    }
  }
  return config;
}

// Flatten RouteConfig into D1 rows for upsert
function routeConfigToRows(config: RouteConfig): RouteRuleRow[] {
  const rows: RouteRuleRow[] = [
    {
      prefix: DEFAULT_PREFIX,
      telegram_chats: JSON.stringify(config.default.telegramChats),
      emails: JSON.stringify(config.default.emails)
    }
  ];
  for (const rule of config.routes) {
    rows.push({
      prefix: rule.prefix,
      telegram_chats: JSON.stringify(rule.telegramChats),
      emails: JSON.stringify(rule.emails)
    });
  }
  return rows;
}

export function parseRouteConfig(raw: string | undefined): RouteConfig {
  if (!raw) return FALLBACK_ROUTE_CONFIG;
  try {
    const parsed = JSON.parse(raw) as RouteConfig;
    if (!parsed.default || !Array.isArray(parsed.routes)) {
      return FALLBACK_ROUTE_CONFIG;
    }
    return parsed;
  } catch {
    return FALLBACK_ROUTE_CONFIG;
  }
}

export async function loadRouteConfig(env: Env): Promise<RouteConfig> {
  const { results } = await env.DB.prepare(
    "SELECT prefix, telegram_chats, emails FROM route_rules"
  ).all<RouteRuleRow>();
  if (!results || results.length === 0) return FALLBACK_ROUTE_CONFIG;
  return rowsToRouteConfig(results);
}

export async function saveRouteConfig(env: Env, config: RouteConfig): Promise<void> {
  const rows = routeConfigToRows(config);
  // Clear existing rules and insert new ones in a batch
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM route_rules")
  ];
  for (const row of rows) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO route_rules (prefix, telegram_chats, emails, updated_at) VALUES (?, ?, ?, datetime('now'))"
      ).bind(row.prefix, row.telegram_chats, row.emails)
    );
  }
  await env.DB.batch(stmts);
}

export function isAiEnabled(env: Env): boolean {
  return (env.ENABLE_AI_EXTRACT ?? "false").toLowerCase() === "true";
}

export function getAiTimeoutMs(env: Env): number {
  const parsed = Number(env.AI_TIMEOUT_MS ?? "4500");
  if (!Number.isFinite(parsed) || parsed < 500) return 4500;
  return parsed;
}

export function getAiModel(env: Env): string {
  return env.AI_MODEL_NAME ?? "@cf/meta/llama-3.1-8b-instruct";
}
