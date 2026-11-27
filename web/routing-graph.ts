// Turns the rule lists plus routing activity into the topology the graph view
// draws: receiving addresses on the left, outlets on the right, one edge per
// rule. Kept free of DOM and app.ts, like routing-table.ts, so the graph
// semantics can be tested on their own.
import type { ChannelKey, ChannelRule, PrefixActivity, RuleActivity } from './api-types.js';

const WILDCARD = '*';
const CHANNEL_RANK: Record<ChannelKey, number> = { forward: 0, tg: 1, bark: 2 };

// What a new rule for this outlet starts with, so "add a rule here" only asks
// for the prefix.
export type OutletPreset =
  | { channel: 'forward'; destination_id: number }
  | { channel: 'bark'; endpoint_id: number }
  | { channel: 'tg'; chat_id: string; bot_id: number | null };

interface OutletTarget {
  key: string;
  label: string | undefined;
  detail: string | undefined;
  preset: OutletPreset;
}

export interface GraphSource {
  prefix: string;
  wildcard: boolean;
  emailCount: number;
  lastReceivedAt: string | null;
  // Enabled rules leaving this address.
  fanOut: number;
}

export interface GraphOutlet extends OutletTarget {
  channel: ChannelKey;
  // Addresses with an enabled rule into this outlet.
  fanIn: number;
}

export interface GraphEdge {
  ruleKey: string;
  channel: ChannelKey;
  prefix: string;
  outletKey: string;
  enabled: boolean;
}

export interface UnroutedPrefix {
  prefix: string;
  emailCount: number;
  lastReceivedAt: string | null;
}

export interface RoutingGraph {
  sources: GraphSource[];
  outlets: GraphOutlet[];
  edges: GraphEdge[];
  unrouted: UnroutedPrefix[];
}

// Rules that deliver to the same place share one outlet node. A Telegram chat
// reached through two different bots is two outlets: the delivery path, and
// what can fail, differs per bot.
function outletOf(rule: ChannelRule): OutletTarget {
  if (rule.channel === 'forward') {
    return {
      key: `forward:${rule.destination_id}`,
      label: rule.destination_name,
      detail: rule.target_email,
      preset: { channel: 'forward', destination_id: rule.destination_id },
    };
  }
  if (rule.channel === 'bark') {
    return {
      key: `bark:${rule.endpoint_id}`,
      label: rule.endpoint_name,
      detail: rule.server_url,
      preset: { channel: 'bark', endpoint_id: rule.endpoint_id },
    };
  }
  return {
    key: `tg:${rule.chat_id}:${rule.bot_id}`,
    label: rule.chat_id,
    detail: rule.bot_name || '未绑定 Bot',
    preset: { channel: 'tg', chat_id: rule.chat_id, bot_id: rule.bot_id },
  };
}

export function buildRoutingGraph(rules: ChannelRule[], activity: Partial<RuleActivity> = {}): RoutingGraph {
  const received = new Map<string, PrefixActivity>((activity.prefixes || [])
    .map((entry) => [entry.prefix, entry]));

  const sources = new Map<string, GraphSource>();
  const outlets = new Map<string, OutletTarget & { channel: ChannelKey; activePrefixes: Set<string> }>();
  const edges: GraphEdge[] = [];

  for (const rule of rules) {
    const outlet = outletOf(rule);
    const enabled = Boolean(rule.enabled);
    let source = sources.get(rule.prefix);
    if (!source) {
      const entry = received.get(rule.prefix);
      source = {
        prefix: rule.prefix,
        wildcard: rule.prefix === WILDCARD,
        emailCount: entry?.email_count || 0,
        lastReceivedAt: entry?.last_received_at || null,
        fanOut: 0,
      };
      sources.set(rule.prefix, source);
    }
    let node = outlets.get(outlet.key);
    if (!node) {
      node = { ...outlet, channel: rule.channel, activePrefixes: new Set() };
      outlets.set(outlet.key, node);
    }
    if (enabled) {
      source.fanOut += 1;
      node.activePrefixes.add(rule.prefix);
    }
    edges.push({
      ruleKey: `${rule.channel}:${rule.id}`,
      channel: rule.channel,
      prefix: rule.prefix,
      outletKey: outlet.key,
      enabled,
    });
  }

  // Busiest addresses first: they are the ones worth checking. The wildcard
  // goes last because it is not an address of its own.
  const sourceList = [...sources.values()].sort((a, b) => (Number(a.wildcard) - Number(b.wildcard))
    || b.emailCount - a.emailCount
    || a.prefix.localeCompare(b.prefix, 'en', { sensitivity: 'base' }));

  const outletList = [...outlets.values()]
    .map(({ activePrefixes, ...outlet }) => ({ ...outlet, fanIn: activePrefixes.size }))
    .sort((a, b) => CHANNEL_RANK[a.channel] - CHANNEL_RANK[b.channel]
      || String(a.label).localeCompare(String(b.label), 'zh-CN'));

  // Addresses that received mail without any rule (even a disabled one): the
  // mail is stored but goes nowhere, which the table view cannot show at a glance.
  const unrouted = [...received.values()]
    .filter((entry) => entry.prefix !== WILDCARD && !sources.has(entry.prefix))
    .map((entry) => ({
      prefix: entry.prefix,
      emailCount: entry.email_count || 0,
      lastReceivedAt: entry.last_received_at || null,
    }))
    .sort((a, b) => b.emailCount - a.emailCount || a.prefix.localeCompare(b.prefix));

  return { sources: sourceList, outlets: outletList, edges, unrouted };
}
