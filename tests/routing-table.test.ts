import { describe, expect, it } from 'vitest';
import { activeOutletCount, buildRoutingTable } from '../web/routing-table.js';

const forward = (id, prefix, name, extra = {}) => ({
  channel: 'forward', id, prefix, destination_name: name, target_email: `${name}@x.com`, enabled: 1, ...extra,
});
const tg = (id, prefix, chatId, extra = {}) => ({
  channel: 'tg', id, prefix, chat_id: chatId, bot_name: 'Bot', enabled: 1, ...extra,
});

describe('routing table', () => {
  it('merges enabled wildcard outlets into every prefix, without their status light', () => {
    const table = buildRoutingTable([
      forward(1, 'github', 'icloud'),
      forward(2, '*', 'archive'),
      forward(3, '*', 'old', { enabled: 0 }),
    ], { deliveries: [{ channel: 'forward', rule_id: 2, status: 'failed', last_triggered_at: 't' }] });

    const github = table.find((route) => route.prefix === 'github');
    expect(github.inherited.map((outlet) => outlet.label)).toEqual(['archive']);
    expect(github.inherited[0]).toMatchObject({ inherited: true, delivery: null });
    expect(activeOutletCount(github)).toBe(2);

    const wildcard = table.at(-1);
    expect(wildcard).toMatchObject({ prefix: '*', wildcard: true, inherited: [] });
    expect(wildcard.own.find((outlet) => outlet.label === 'archive').delivery.status).toBe('failed');
  });

  it('attaches the latest delivery to each outlet by channel and rule id', () => {
    const [route] = buildRoutingTable([forward(5, 'gpt', 'qq'), tg(5, 'gpt', '123')], {
      deliveries: [{ channel: 'tg', rule_id: 5, status: 'failed', last_error: 'chat not found', last_triggered_at: 't1' }],
    });
    expect(route.own.map((outlet) => [outlet.channel, outlet.delivery?.status ?? null]))
      .toEqual([['forward', null], ['tg', 'failed']]);
    expect(route.own[1].delivery.error).toBe('chat not found');
  });

  it('lists configured prefixes alphabetically, then mail-only prefixes, then the wildcard', () => {
    const table = buildRoutingTable([
      forward(1, 'gpt', 'a'), forward(2, '*', 'b'), forward(3, 'bank', 'c'),
    ], {
      prefixes: [
        { prefix: 'shopping', last_received_at: 't2', email_count: 3 },
        { prefix: 'gpt', last_received_at: 't1', email_count: 9 },
      ],
    });
    expect(table.map((route) => route.prefix)).toEqual(['bank', 'gpt', 'shopping', '*']);
    expect(table[1]).toMatchObject({ lastReceivedAt: 't1', emailCount: 9 });
    expect(table[2].own).toEqual([]);
    expect(activeOutletCount(table[2])).toBe(1);
  });

  it('counts a disabled outlet as present but not active', () => {
    const [route] = buildRoutingTable([forward(1, 'a', 'x', { enabled: 0 })]);
    expect(route.own).toHaveLength(1);
    expect(activeOutletCount(route)).toBe(0);
  });
});
