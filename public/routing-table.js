// Turns the three rule lists plus routing activity into the routing table the
// rules view renders: one row per receiving prefix, each listing every outlet a
// mail to that address actually reaches. Kept free of DOM and app.js so the
// routing semantics can be tested on their own.

const WILDCARD = '*';

function outletOf(rule, deliveries) {
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

function byChannelThenLabel(a, b) {
  const rank = { forward: 0, tg: 1, bark: 2 };
  return rank[a.channel] - rank[b.channel]
    || String(a.label).localeCompare(String(b.label), 'zh-CN');
}

export function buildRoutingTable(rules, activity = {}) {
  const deliveries = new Map((activity.deliveries || [])
    .map((delivery) => [`${delivery.channel}:${delivery.rule_id}`, delivery]));
  const received = new Map((activity.prefixes || [])
    .map((entry) => [entry.prefix, entry]));

  const ownByPrefix = new Map();
  for (const rule of rules) {
    if (!ownByPrefix.has(rule.prefix)) ownByPrefix.set(rule.prefix, []);
    ownByPrefix.get(rule.prefix).push(outletOf(rule, deliveries));
  }

  // A disabled wildcard rule does not fire, so it is not inherited. Its status
  // light stays on the * row: its latest delivery may belong to another prefix.
  const inherited = (ownByPrefix.get(WILDCARD) || [])
    .filter((outlet) => outlet.enabled)
    .map((outlet) => ({ ...outlet, inherited: true, delivery: null }))
    .sort(byChannelThenLabel);

  const route = (prefix) => {
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
export function activeOutletCount(route) {
  return route.own.filter((outlet) => outlet.enabled).length + route.inherited.length;
}
