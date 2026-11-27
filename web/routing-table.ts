// Turns the three rule lists plus routing activity into the routing table the
// rules view renders: one row per receiving prefix, each listing every outlet a
// mail to that address actually reaches. Kept free of DOM and app.ts so the
// routing semantics can be tested on their own.
import type {
  ChannelKey, ChannelRule, DownstreamStatus, PrefixActivity, RuleActivity, RuleDeliveryActivity,
} from './api-types.js';

const WILDCARD = '*';

export interface OutletDelivery {
  status: DownstreamStatus;
  at: string;
  error: string;
}

// One rule as seen from a route: where the mail goes and how its last
// delivery went.
export interface RouteOutlet {
  key: string;
  channel: ChannelKey;
  enabled: boolean;
  delivery: OutletDelivery | null;
  label: string | undefined;
  detail: string | undefined;
  // Set on the wildcard's outlets when they are listed under another prefix.
  inherited?: boolean;
}

export interface Route {
  prefix: string;
  wildcard: boolean;
  lastReceivedAt: string | null;
  emailCount: number;
  own: RouteOutlet[];
  inherited: RouteOutlet[];
}

function outletOf(rule: ChannelRule, deliveries: Map<string, RuleDeliveryActivity>): RouteOutlet {
  const key = `${rule.channel}:${rule.id}`;
  const delivery = deliveries.get(key) || null;
  const base = {
    key,
    channel: rule.channel,
    enabled: Boolean(rule.enabled),
    delivery: delivery && {
      status: delivery.status,
      at: delivery.last_triggered_at,
      error: delivery.last_error || '',
    },
  };
  if (rule.channel === 'forward') {
    return { ...base, label: rule.destination_name, detail: rule.target_email };
  }
  if (rule.channel === 'bark') {
    return { ...base, label: rule.endpoint_name, detail: rule.server_url };
  }
  return { ...base, label: rule.chat_id, detail: rule.bot_name || '未绑定 Bot' };
}

const CHANNEL_RANK: Record<ChannelKey, number> = { forward: 0, tg: 1, bark: 2 };

function byChannelThenLabel(a: RouteOutlet, b: RouteOutlet): number {
  return CHANNEL_RANK[a.channel] - CHANNEL_RANK[b.channel]
    || String(a.label).localeCompare(String(b.label), 'zh-CN');
}

export function buildRoutingTable(rules: ChannelRule[], activity: Partial<RuleActivity> = {}): Route[] {
  const deliveries = new Map<string, RuleDeliveryActivity>((activity.deliveries || [])
    .map((delivery) => [`${delivery.channel}:${delivery.rule_id}`, delivery]));
  const received = new Map<string, PrefixActivity>((activity.prefixes || [])
    .map((entry) => [entry.prefix, entry]));

  const ownByPrefix = new Map<string, RouteOutlet[]>();
  for (const rule of rules) {
    const own = ownByPrefix.get(rule.prefix) ?? [];
    own.push(outletOf(rule, deliveries));
    ownByPrefix.set(rule.prefix, own);
  }

  // A disabled wildcard rule does not fire, so it is not inherited. Its status
  // light stays on the * row: its latest delivery may belong to another prefix.
  const inherited = (ownByPrefix.get(WILDCARD) || [])
    .filter((outlet) => outlet.enabled)
    .map((outlet) => ({ ...outlet, inherited: true, delivery: null }))
    .sort(byChannelThenLabel);

  const route = (prefix: string): Route => {
    const activityEntry = received.get(prefix);
    const wildcard = prefix === WILDCARD;
    return {
      prefix,
      wildcard,
      lastReceivedAt: activityEntry?.last_received_at || null,
      emailCount: activityEntry?.email_count || 0,
      own: (ownByPrefix.get(prefix) || []).slice().sort(byChannelThenLabel),
      inherited: wildcard ? [] : inherited,
    };
  };

  const configured = [...ownByPrefix.keys()]
    .filter((prefix) => prefix !== WILDCARD)
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
    .map(route);
  // Addresses that have received mail but have no rule of their own: shown so
  // the customer sees every address in use, like an unpatched router port.
  const receivedOnly = [...received.keys()]
    .filter((prefix) => prefix !== WILDCARD && !ownByPrefix.has(prefix))
    .map(route);
  const wildcardRoute = ownByPrefix.has(WILDCARD) ? [route(WILDCARD)] : [];

  return [...configured, ...receivedOnly, ...wildcardRoute];
}

// How many outlets a mail to this route reaches right now.
export function activeOutletCount(route: Route): number {
  return route.own.filter((outlet) => outlet.enabled).length + route.inherited.length;
}
