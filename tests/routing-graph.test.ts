import { describe, expect, it } from 'vitest';
import { buildRoutingGraph } from '../web/routing-graph.js';

const forward = (id, prefix, destinationId, extra = {}) => ({
  channel: 'forward', id, prefix, destination_id: destinationId,
  destination_name: `dest${destinationId}`, target_email: `d${destinationId}@x.com`, enabled: 1, ...extra,
});
const tg = (id, prefix, chatId, botId, extra = {}) => ({
  channel: 'tg', id, prefix, chat_id: chatId, bot_id: botId, bot_name: `bot${botId}`, enabled: 1, ...extra,
});
const bark = (id, prefix, endpointId) => ({
  channel: 'bark', id, prefix, endpoint_id: endpointId, endpoint_name: 'iPhone', server_url: 'https://api.day.app', enabled: 1,
});

describe('routing graph', () => {
  it('merges rules that deliver to the same place into one outlet', () => {
    const graph = buildRoutingGraph([
      forward(1, 'i', 7),
      forward(2, 'dev', 7),
      forward(3, 'hi', 8),
    ]);

    expect(graph.outlets.map((outlet) => outlet.key)).toEqual(['forward:7', 'forward:8']);
    expect(graph.outlets[0]).toMatchObject({ fanIn: 2, preset: { channel: 'forward', destination_id: 7 } });
    expect(graph.edges.map((edge) => [edge.ruleKey, edge.outletKey])).toEqual([
      ['forward:1', 'forward:7'],
      ['forward:2', 'forward:7'],
      ['forward:3', 'forward:8'],
    ]);
  });

  it('keeps a Telegram chat reached through two bots as two outlets', () => {
    const graph = buildRoutingGraph([tg(1, 'i', '123', 1), tg(2, 'hi', '123', 2), tg(3, 'dev', '123', 1)]);

    expect(graph.outlets.map((outlet) => [outlet.key, outlet.fanIn])).toEqual([
      ['tg:123:1', 2],
      ['tg:123:2', 1],
    ]);
    expect(graph.outlets[0].preset).toEqual({ channel: 'tg', chat_id: '123', bot_id: 1 });
  });

  it('draws disabled rules but leaves them out of the fan-out and fan-in counts', () => {
    const graph = buildRoutingGraph([forward(1, 'i', 7), forward(2, 'i', 8, { enabled: 0 })]);

    expect(graph.edges.map((edge) => edge.enabled)).toEqual([true, false]);
    expect(graph.sources[0].fanOut).toBe(1);
    expect(graph.outlets.find((outlet) => outlet.key === 'forward:8').fanIn).toBe(0);
  });

  it('orders addresses by received mail, wildcard last, outlets by channel', () => {
    const graph = buildRoutingGraph([
      bark(1, '*', 3),
      tg(2, 'quiet', '9', 1),
      forward(3, 'busy', 7),
    ], {
      prefixes: [
        { prefix: 'busy', email_count: 40, last_received_at: '2026-01-02 00:00:00' },
        { prefix: 'quiet', email_count: 2, last_received_at: '2026-01-01 00:00:00' },
      ],
    });

    expect(graph.sources.map((source) => source.prefix)).toEqual(['busy', 'quiet', '*']);
    expect(graph.sources[0]).toMatchObject({ emailCount: 40, lastReceivedAt: '2026-01-02 00:00:00' });
    expect(graph.sources[2]).toMatchObject({ wildcard: true, emailCount: 0, lastReceivedAt: null });
    expect(graph.outlets.map((outlet) => outlet.channel)).toEqual(['forward', 'tg', 'bark']);
  });

  it('lists addresses that received mail without any rule as unrouted', () => {
    const graph = buildRoutingGraph([forward(1, 'i', 7), forward(2, 'old', 7, { enabled: 0 })], {
      prefixes: [
        { prefix: 'i', email_count: 9 },
        { prefix: 'old', email_count: 5 },
        { prefix: 'railway', email_count: 3 },
        { prefix: 'ng', email_count: 17 },
      ],
    });

    // A disabled rule still means the customer decided where the mail goes.
    expect(graph.unrouted.map((entry) => [entry.prefix, entry.emailCount])).toEqual([['ng', 17], ['railway', 3]]);
  });
});
