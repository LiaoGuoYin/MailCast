// Turns the rule lists plus routing activity into the topology the graph view
// draws: receiving addresses on the left, outlets on the right, one edge per
// rule. Kept free of DOM and app.js, like routing-table.js, so the graph
// semantics can be tested on their own.

const WILDCARD = '*';
const CHANNEL_RANK = { forward: 0, tg: 1, bark: 2 };

// Rules that deliver to the same place share one outlet node. A Telegram chat
// reached through two different bots is two outlets: the delivery path, and
// what can fail, differs per bot.
function outletOf(rule) {
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

export function buildRoutingGraph(rules, activity = {}) {
  const received = new Map((activity.prefixes || [])
    .map((entry) => [entry.prefix, entry]));

  const sources = new Map();
  const outlets = new Map();
  const edges = [];

  for (const rule of rules) {
    const outlet = outletOf(rule);
    const enabled = Boolean(rule.enabled);
    if (!sources.has(rule.prefix)) {
      const entry = received.get(rule.prefix);
      sources.set(rule.prefix, {
        prefix: rule.prefix,
        wildcard: rule.prefix === WILDCARD,
        emailCount: entry?.email_count || 0,
        lastReceivedAt: entry?.last_received_at || null,
        fanOut: 0,
      });
    }
    if (!outlets.has(outlet.key)) {
      outlets.set(outlet.key, { ...outlet, channel: rule.channel, activePrefixes: new Set() });
    }
    if (enabled) {
      sources.get(rule.prefix).fanOut += 1;
      outlets.get(outlet.key).activePrefixes.add(rule.prefix);
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
  const sourceList = [...sources.values()].sort((a, b) => (a.wildcard - b.wildcard)
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
