import type { RouteConfig } from "../config";

export interface RouteTargets {
  routeKey: string;
  telegramChats: string[];
  emails: string[];
}

export function normalizeLocalPart(address: string): string {
  const [localPart] = address.split("@");
  return (localPart ?? "").toLowerCase().trim();
}

export function resolveRouteTargets(to: string, routeConfig: RouteConfig): RouteTargets {
  const local = normalizeLocalPart(to);
  const matched = routeConfig.routes.find((rule) => local.startsWith(rule.prefix.toLowerCase()));
  if (matched) {
    return {
      routeKey: matched.prefix,
      telegramChats: matched.telegramChats,
      emails: matched.emails
    };
  }
  return {
    routeKey: "default",
    telegramChats: routeConfig.default.telegramChats,
    emails: routeConfig.default.emails
  };
}
