import { describe, expect, it, vi } from 'vitest';
import { mcpAdminRoutes } from '../src/api/mcp-admin';
import { logRoutes } from '../src/api/logs';
import type { AgentTokenRow, Env } from '../src/types';

function fakeAdminDb() {
  const settings: Record<string, string> = {};
  const tokens: AgentTokenRow[] = [];
  const audits: Array<{ action: string; details: string }> = [];
  let nextId = 1;

  const db = {
    prepare: vi.fn((query: string) => {
      let bound: unknown[] = [];
      const stmt = {
        bind: (...values: unknown[]) => {
          bound = values;
          return stmt;
        },
        first: async () => {
          if (query.includes('FROM settings')) {
            const key = String(bound[0]);
            return Object.hasOwn(settings, key) ? { value: settings[key] } : null;
          }
          if (query.includes('FROM agent_tokens') && query.includes('WHERE id = ?')) {
            return tokens.find((t) => t.id === Number(bound[0])) ?? null;
          }
          if (query.includes('COUNT(*) AS total FROM sent_emails')) {
            return { total: 4 };
          }
          if (query.includes('SELECT to_addr FROM emails')) {
            return { to_addr: 'ci@example.com' };
          }
          return null;
        },
        all: async () => {
          if (query.includes('FROM agent_tokens')) {
            return { results: [...tokens] };
          }
          if (query.includes('SELECT prefix FROM')) {
            return { results: [{ prefix: 'ci' }, { prefix: 'agent' }] };
          }
          return { results: [] };
        },
        run: async () => {
          if (query.includes('INSERT INTO settings')) {
            settings[String(bound[0])] = String(bound[1]);
          } else if (query.includes('INSERT INTO agent_tokens')) {
            const id = nextId++;
            tokens.push({
              id,
              name: String(bound[0]),
              kind: 'static',
              token_hash: String(bound[1]),
              token_hint: String(bound[2]),
              scopes: String(bound[3]),
              prefixes: String(bound[4]),
              allow_plus_tags: Number(bound[5]),
              recipient_policy: String(bound[6]) as AgentTokenRow['recipient_policy'],
              recipient_allowlist: String(bound[7]),
              send_limit_hour: Number(bound[8]),
              send_limit_day: Number(bound[9]),
              expires_at: bound[10] === null ? null : String(bound[10]),
              revoked_at: null,
              last_used_at: null,
              last_used_ip: '',
              created_at: String(bound[11]),
              updated_at: String(bound[12]),
            });
            return { meta: { last_row_id: id, changes: 1 } };
          } else if (query.includes('UPDATE agent_tokens') && query.includes('WHERE revoked_at IS NULL')) {
            let changes = 0;
            for (const token of tokens) {
              if (!token.revoked_at) {
                token.revoked_at = String(bound[0]);
                changes += 1;
              }
            }
            return { meta: { changes } };
          } else if (query.includes('INSERT INTO audit_logs')) {
            audits.push({ action: String(bound[1]), details: String(bound[8]) });
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    }),
    batch: vi.fn(async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      for (const s of stmts) await s.run();
      return [];
    }),
  };

  return { db: db as unknown as D1Database, settings, tokens, audits };
}

describe('MCP admin settings API', () => {
  it('reads defaults, updates global settings, creates tokens, and revokes all', async () => {
    const store = fakeAdminDb();
    const env = { DB: store.db } as Env;

    const initial = await mcpAdminRoutes.request('/', {}, env);
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({
      settings: { enabled: true, daily_send_limit: 30 },
      endpoint_path: '/mcp',
      known_prefixes: ['ci', 'agent'],
      usage: { instance_day_used: 4 },
    });

    const updated = await mcpAdminRoutes.request('/', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, daily_send_limit: 15 }),
    }, env);
    expect(updated.status).toBe(200);
    expect(store.settings.mcp_enabled).toBe('0');
    expect(store.settings.mcp_daily_send_limit).toBe('15');

    const createdRes = await mcpAdminRoutes.request('/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Codex Local',
        scopes: ['mail:read'],
        prefixes: ['ci'],
      }),
    }, env);
    expect(createdRes.status).toBe(201);
    const created = await createdRes.json<{ token: string; item: { id: number; status: string } }>();
    expect(created.token).toMatch(/^mc_/);
    expect(created.item.status).toBe('active');
    // Plaintext token must never appear in audit logs
    expect(store.audits.some((a) => a.details.includes(created.token))).toBe(false);

    const revokeAllRes = await mcpAdminRoutes.request('/tokens/revoke-all', {
      method: 'POST',
    }, env);
    expect(revokeAllRes.status).toBe(200);
    await expect(revokeAllRes.json()).resolves.toEqual({ success: true, revoked_count: 1 });
  });

  it('filters audit logs by actor=agent and actor_id', async () => {
    const calls: Array<{ query: string; values: unknown[] }> = [];
    const db = {
      prepare: vi.fn((query: string) => ({
        bind: (...values: unknown[]) => {
          calls.push({ query, values });
          return {
            first: async () => ({ total: 1 }),
            all: async () => ({
              results: [{
                id: 50,
                category: 'email',
                action: 'mcp.email.read',
                status: 'success',
                actor: 'agent',
                actor_id: '7',
                target_type: 'email',
                target_id: '12',
                summary: 'Agent 读取邮件 #12',
                details: '{"tool":"get_email","agent_token_name":"Codex"}',
                ip_address: '203.0.113.5',
                created_at: '2026-11-27T12:00:00.000Z',
              }],
            }),
          };
        },
      })),
    };

    const res = await logRoutes.request('/?actor=agent&actor_id=7', {}, { DB: db } as unknown as Env);
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Array<{ actor: string; actor_id: string }> }>();
    expect(body.data[0]).toMatchObject({ actor: 'agent', actor_id: '7' });
    expect(calls[0].values).toEqual(['agent', '7']);

    const badActor = await logRoutes.request('/?actor=robot', {}, { DB: db } as unknown as Env);
    expect(badActor.status).toBe(400);
  });
});
