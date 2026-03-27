import type { RouteRule } from "../config";

export interface RouteDecision {
  matched: boolean;
  reason: string;
}

export function matchByPrefix(localPart: string, rule: RouteRule): RouteDecision {
  const matched = localPart.toLowerCase().startsWith(rule.prefix.toLowerCase());
  return {
    matched,
    reason: matched ? `prefix:${rule.prefix}` : "prefix:not-match"
  };
}

export function matchBySenderDomain(sender: string, domains: string[]): RouteDecision {
  const senderDomain = sender.split("@")[1]?.toLowerCase() ?? "";
  const matched = domains.map((v) => v.toLowerCase()).includes(senderDomain);
  return {
    matched,
    reason: matched ? `domain:${senderDomain}` : "domain:not-match"
  };
}
