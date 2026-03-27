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
  MAIL_CACHE?: KVNamespace;
  ROUTE_CONFIG_STORE?: KVNamespace;
  AI: Ai;
}

const FALLBACK_ROUTE_CONFIG: RouteConfig = {
  default: {
    telegramChats: [],
    emails: []
  },
  routes: []
};

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

export const ROUTE_CONFIG_KV_KEY = "route-config:v1";

export async function loadRouteConfig(env: Env): Promise<RouteConfig> {
  if (!env.ROUTE_CONFIG_STORE) {
    throw new Error("ROUTE_CONFIG_STORE is not configured");
  }
  const fromKv = await env.ROUTE_CONFIG_STORE.get(ROUTE_CONFIG_KV_KEY);
  return parseRouteConfig(fromKv ?? undefined);
}

export async function saveRouteConfig(env: Env, config: RouteConfig): Promise<void> {
  if (!env.ROUTE_CONFIG_STORE) {
    throw new Error("ROUTE_CONFIG_STORE is not configured");
  }
  await env.ROUTE_CONFIG_STORE.put(ROUTE_CONFIG_KV_KEY, JSON.stringify(config));
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
