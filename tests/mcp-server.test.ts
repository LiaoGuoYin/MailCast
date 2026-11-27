import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentToken, type CreateAgentTokenInput } from '../src/auth/agent-token';
import { createMcpRoutes } from '../src/mcp/handler';
import { mcpAdminRoutes } from '../src/api/mcp-admin';
import type { AgentTokenRow, EmailRecord, Env, SentEmailRecord } from '../src/types';

interface StoredSentRow extends SentEmailRecord {
  agent_token_id: number | null;
  idempotency_key: string | null;
  idempotency_hash: string;
}

function createInMemoryMcpDb(initial?: {
  settings?: Record<string, string>;
  emails?: EmailRecord[];
}) {
  const settings: Record<string, string> = {
    email_provider: 'resend',
    resend_api_key: 're_test_key',
    email_from_address: 'forwarder@mail.example.com',
    mcp_enabled: '1',
    mcp_daily_send_limit: '30',
    ...(initial?.settings ?? {}),
  };
  const tokens: AgentTokenRow[] = [];
  const emails: EmailRecord[] = [...(initial?.emails ?? [])];
  const sentEmails: StoredSentRow[] = [];
  const auditLogs: Array<{
    category: string;
    action: string;
    status: string;
    actor: string;
    actor_id: string;
    target_type: string;
    target_id: string;
    summary: string;
    details: Record<string, unknown>;
  }> = [];

  let nextTokenId = 1;
  let nextSentId = 100;

  function matchesPrefixClause(prefix: string, sql: string, values: unknown[]): boolean {
    if (!sql.includes('to_prefix')) return true;
    // Extract exact and range pairs from bound values in order.
    const clauses = [...sql.matchAll(/\(to_prefix = \? OR \(to_prefix >= \? AND to_prefix < \?\)\)|to_prefix = \?/g)];
    if (clauses.length === 0) return true;
    let idx = 0;
    for (const match of clauses) {
      if (match[0].includes('>=')) {
        const exact = String(values[idx]);
        const low = String(values[idx + 1]);
        const high = String(values[idx + 2]);
        idx += 3;
        if (prefix === exact || (prefix >= low && prefix < high)) return true;
      } else {
        const exact = String(values[idx]);
        idx += 1;
        if (prefix === exact) return true;
      }
    }
    return false;
  }

  function countPrefixParams(sql: string): number {
    const clauses = [...sql.matchAll(/\(to_prefix = \? OR \(to_prefix >= \? AND to_prefix < \?\)\)|to_prefix = \?/g)];
    return clauses.reduce((sum, m) => sum + (m[0].includes('>=') ? 3 : 1), 0);
  }

  function filterEmails(sql: string, values: unknown[]): EmailRecord[] {
    const prefixParamCount = countPrefixParams(sql);
    let cursor = prefixParamCount;
    let afterId: number | undefined;
    let beforeId: number | undefined;
    let since: string | undefined;
    let fromLike: string | undefined;
    let subjectLike: string | undefined;
    const unreadOnly = sql.includes('is_read = 0');

    if (sql.includes('id > ?')) {
      afterId = Number(values[cursor++]);
    }
    if (sql.includes('id < ?')) {
      beforeId = Number(values[cursor++]);
    }
    if (sql.includes('created_at >= ?')) {
      since = String(values[cursor++]);
    }
    if (sql.includes('lower(from_addr) LIKE ?')) {
      fromLike = String(values[cursor]).replace(/%/g, '');
      cursor += 2;
    }
    if (sql.includes('lower(subject) LIKE ?')) {
      subjectLike = String(values[cursor++]).replace(/%/g, '');
    }

    return emails.filter((row) => {
      if (!matchesPrefixClause(row.to_prefix, sql, values)) return false;
      if (afterId !== undefined && !(row.id > afterId)) return false;
      if (beforeId !== undefined && !(row.id < beforeId)) return false;
      if (since && !(row.created_at >= since)) return false;
      if (unreadOnly && row.is_read !== 0) return false;
      if (
        fromLike
        && !row.from_addr.toLowerCase().includes(fromLike)
        && !(row.envelope_from || '').toLowerCase().includes(fromLike)
      ) {
        return false;
      }
      if (subjectLike && !row.subject.toLowerCase().includes(subjectLike)) return false;
      return true;
    });
  }

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
            const key = String(bound[0] ?? '');
            return Object.hasOwn(settings, key) ? { value: settings[key] } : null;
          }
          if (query.includes('FROM agent_tokens') && query.includes('WHERE token_hash = ?')) {
            return tokens.find((t) => t.token_hash === bound[0]) ?? null;
          }
          if (query.includes('FROM agent_tokens') && query.includes('WHERE id = ?')) {
            return tokens.find((t) => t.id === Number(bound[0])) ?? null;
          }
          if (query.includes('COALESCE(MAX(id), 0) AS latest_id FROM emails')) {
            const latest = emails.reduce((max, row) => Math.max(max, row.id), 0);
            return { latest_id: latest };
          }
          if (query.includes('SELECT to_addr FROM emails ORDER BY id DESC LIMIT 1')) {
            const sorted = [...emails].sort((a, b) => b.id - a.id);
            return sorted[0] ? { to_addr: sorted[0].to_addr } : null;
          }
          if (query.includes('FROM emails') && query.includes('WHERE id = ?')) {
            return emails.find((e) => e.id === Number(bound[0])) ?? null;
          }
          if (query.includes('FROM emails') && query.includes('ORDER BY id ASC')) {
            const matched = filterEmails(query, bound).sort((a, b) => a.id - b.id);
            return matched[0] ?? null;
          }
          if (query.includes('FROM sent_emails') && query.includes('idempotency_key = ?')) {
            return sentEmails.find(
              (s) => s.agent_token_id === Number(bound[0])
                && s.idempotency_key === String(bound[1])
                && s.status === 'success',
            ) ?? null;
          }
          if (query.includes('COUNT(*) AS total FROM sent_emails WHERE agent_token_id IS NOT NULL')) {
            const since = String(bound[0]);
            const total = sentEmails.filter((s) => s.agent_token_id !== null && s.created_at >= since).length;
            return { total };
          }
          if (query.includes('COUNT(*) AS total FROM sent_emails WHERE agent_token_id = ?')) {
            const tokenId = Number(bound[0]);
            const since = String(bound[1]);
            const total = sentEmails.filter((s) => s.agent_token_id === tokenId && s.created_at >= since).length;
            return { total };
          }
          return null;
        },
        all: async () => {
          if (query.includes('FROM agent_tokens')) {
            return { results: [...tokens] };
          }
          if (query.includes('SELECT prefix FROM')) {
            const set = new Set(emails.map((e) => e.to_prefix.split('+')[0]));
            return { results: [...set].map((prefix) => ({ prefix })) };
          }
          if (query.includes('FROM emails') && query.includes('ORDER BY id DESC')) {
            const limit = Number(bound[bound.length - 1]);
            const filtered = filterEmails(query, bound.slice(0, -1))
              .sort((a, b) => b.id - a.id)
              .slice(0, limit)
              .map((row) => ({
                ...row,
                text_preview: row.text_body,
                html_preview: row.html_body,
              }));
            return { results: filtered };
          }
          if (query.includes('FROM sent_emails') && query.includes('WHERE reply_to_email_id = ?')) {
            const replyToId = Number(bound[0]);
            return {
              results: sentEmails
                .filter((s) => s.reply_to_email_id === replyToId)
                .sort((a, b) => b.id - a.id),
            };
          }
          if (query.includes('FROM sent_emails')) {
            const limit = Number(bound[bound.length - 1]);
            const args = bound.slice(0, -1);
            let rows = [...sentEmails];
            if (query.includes('from_prefix = ?')) {
              rows = rows.filter((s) => s.from_prefix === String(args[0]));
            } else if (query.includes('from_prefix IN (')) {
              const allowed = new Set(args.slice(0, query.includes('id < ?') ? -1 : args.length).map(String));
              rows = rows.filter((s) => allowed.has(s.from_prefix));
            }
            if (query.includes('id < ?')) {
              const beforeId = Number(args[args.length - 1]);
              rows = rows.filter((s) => s.id < beforeId);
            }
            rows.sort((a, b) => b.id - a.id);
            return { results: rows.slice(0, limit) };
          }
          return { results: [] };
        },
        run: async () => {
          if (query.includes('INSERT INTO settings')) {
            settings[String(bound[0])] = String(bound[1]);
            return { meta: { changes: 1 } };
          }
          if (query.includes('INSERT INTO agent_tokens')) {
            const id = nextTokenId++;
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
          }
          if (query.includes('UPDATE agent_tokens') && query.includes('SET last_used_at')) {
            const token = tokens.find((t) => t.id === Number(bound[2]));
            if (token && (!token.last_used_at || token.last_used_at < String(bound[3]))) {
              token.last_used_at = String(bound[0]);
              token.last_used_ip = String(bound[1]);
            }
            return { meta: { changes: 1 } };
          }
          if (query.includes('UPDATE agent_tokens') && query.includes('WHERE id = ? AND revoked_at IS NULL')) {
            const token = tokens.find((t) => t.id === Number(bound[2]) && !t.revoked_at);
            if (!token) return { meta: { changes: 0 } };
            token.revoked_at = String(bound[0]);
            token.updated_at = String(bound[1]);
            return { meta: { changes: 1 } };
          }
          if (query.includes('UPDATE agent_tokens') && query.includes('WHERE revoked_at IS NULL')) {
            let changes = 0;
            for (const token of tokens) {
              if (!token.revoked_at) {
                token.revoked_at = String(bound[0]);
                token.updated_at = String(bound[1]);
                changes += 1;
              }
            }
            return { meta: { changes } };
          }
          if (query.includes('INSERT INTO sent_emails')) {
            const id = nextSentId++;
            sentEmails.push({
              id,
              from_prefix: String(bound[0]),
              from_addr: String(bound[1]),
              to_addr: String(bound[2]),
              reply_to: String(bound[3]),
              subject: String(bound[4]),
              text_body: String(bound[5]),
              reply_to_email_id: bound[6] === null ? null : Number(bound[6]),
              provider: String(bound[7]) as SentEmailRecord['provider'],
              provider_message_id: String(bound[8]),
              status: String(bound[9]) as SentEmailRecord['status'],
              error: String(bound[10]),
              created_at: String(bound[11]),
              agent_token_id: bound[12] === null ? null : Number(bound[12]),
              idempotency_key: bound[13] === null ? null : String(bound[13]),
              idempotency_hash: String(bound[14] ?? ''),
            });
            return { meta: { last_row_id: id, changes: 1 } };
          }
          if (query.includes('INSERT INTO audit_logs')) {
            auditLogs.push({
              category: String(bound[0]),
              action: String(bound[1]),
              status: String(bound[2]),
              actor: String(bound[3]),
              actor_id: String(bound[4]),
              target_type: String(bound[5]),
              target_id: String(bound[6]),
              summary: String(bound[7]),
              details: JSON.parse(String(bound[8] || '{}')),
            });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    }),
    batch: vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) => {
      for (const stmt of statements) await stmt.run();
      return [];
    }),
  };

  return {
    db: db as unknown as D1Database,
    settings,
    tokens,
    emails,
    sentEmails,
    auditLogs,
    async issueToken(overrides: Partial<CreateAgentTokenInput> = {}) {
      return createAgentToken(db as unknown as D1Database, {
        name: 'Test Agent',
        scopes: ['mail:read'],
        prefixes: ['ci'],
        allowPlusTags: true,
        recipientPolicy: 'allowlist',
        recipientAllowlist: ['alice@example.com'],
        sendLimitHour: 10,
        sendLimitDay: 30,
        expiresInDays: 90,
        ...overrides,
      });
    },
  };
}

function makeEmail(overrides: Partial<EmailRecord> & { id: number }): EmailRecord {
  return {
    from_addr: 'noreply@github.com',
    envelope_from: 'bounce@github.com',
    to_addr: 'ci+github@example.com',
    to_prefix: 'ci+github',
    subject: 'Your GitHub verification code: 739104',
    text_body: 'Enter code 739104 to verify. https://github.com/verify?c=1',
    html_body: '',
    body_truncated: 0,
    raw_body: 'From: GitHub <noreply@github.com>\r\nReply-To: reply@github.com\r\nMessage-ID: <gh-1@github.com>\r\n\r\nEnter code 739104',
    raw_truncated: 0,
    downstream_recorded: 1,
    is_read: 0,
    created_at: '2026-11-27T10:00:00.000Z',
    ...overrides,
  };
}

describe('MCP Streamable HTTP endpoint & SDK compliance', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes full official @modelcontextprotocol/sdk Client handshake, tool discovery, and read/wait calls', async () => {
    const store = createInMemoryMcpDb({
      emails: [
        makeEmail({ id: 1, to_addr: 'ci+github@example.com', to_prefix: 'ci+github' }),
        makeEmail({
          id: 2,
          to_addr: 'private@example.com',
          to_prefix: 'private',
          subject: 'Top secret bank statement',
          text_body: 'Secret balance',
        }),
      ],
    });
    const { token } = await store.issueToken({
      name: 'Codex Readonly',
      scopes: ['mail:read'],
      prefixes: ['ci'],
      allowPlusTags: true,
    });

    let pollCount = 0;
    const mcpApp = new Hono<{ Bindings: Env }>();
    mcpApp.route('/mcp', createMcpRoutes({
      pollIntervalMs: 10,
      sleep: async () => {
        pollCount += 1;
        if (pollCount === 1) {
          store.emails.push(makeEmail({
            id: 3,
            to_addr: 'ci+openai@example.com',
            to_prefix: 'ci+openai',
            subject: 'OpenAI login code',
            text_body: 'Your verification code is 554433.',
          }));
        }
      },
    }));

    const customFetch: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      return mcpApp.fetch(request, { DB: store.db } as Env);
    };

    const transport = new StreamableHTTPClientTransport(new URL('https://mail.example.com/mcp'), {
      fetch: customFetch,
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });
    const client = new Client({ name: 'codex-test-client', version: '1.0.0' });
    await client.connect(transport);

    expect(client.getInstructions()).toContain('UNTRUSTED');

    // Read-only token must not advertise send_email or reply_email
    const listedTools = await client.listTools();
    const toolNames = listedTools.tools.map((t) => t.name);
    expect(toolNames).toEqual([
      'get_mailbox_info',
      'list_emails',
      'get_email',
      'wait_for_email',
      'list_sent_emails',
    ]);

    // 1. get_mailbox_info returns scoped prefixes and latest_email_id
    const infoRes = await client.callTool({ name: 'get_mailbox_info', arguments: {} });
    expect(infoRes.isError).toBeFalsy();
    const info = infoRes.structuredContent as Record<string, unknown>;
    expect(info.prefixes).toEqual(['ci']);
    expect(info.latest_email_id).toBe(2);
    expect(info.addresses).toEqual(['ci@example.com']);

    // 2. list_emails returns ci+github but hides private@
    const listRes = await client.callTool({ name: 'list_emails', arguments: { prefix: 'ci' } });
    const listPayload = listRes.structuredContent as { emails: Array<{ id: number; to_prefix: string }> };
    expect(listPayload.emails).toHaveLength(1);
    expect(listPayload.emails[0].id).toBe(1);
    expect(listPayload.emails[0].to_prefix).toBe('ci+github');

    // 3. get_email returns code_candidates, links, and does NOT mutate is_read
    const emailRes = await client.callTool({ name: 'get_email', arguments: { id: 1 } });
    const emailPayload = emailRes.structuredContent as {
      email: {
        from_addr_authenticated: boolean;
        untrusted: { code_candidates: string[]; links: Array<{ host: string }> };
      };
    };
    expect(emailPayload.email.from_addr_authenticated).toBe(false);
    expect(emailPayload.email.untrusted.code_candidates).toContain('739104');
    expect(emailPayload.email.untrusted.links[0].host).toBe('github.com');
    expect(store.emails[0].is_read).toBe(0);

    // 4. get_email rejects out-of-scope email #2 with isError=true
    const forbiddenRes = await client.callTool({ name: 'get_email', arguments: { id: 2 } });
    expect(forbiddenRes.isError).toBe(true);
    expect((forbiddenRes.structuredContent as { code: string }).code).toBe('FORBIDDEN_PREFIX');

    // 5. wait_for_email catches newly arrived email #3 on second poll
    const waitRes = await client.callTool({
      name: 'wait_for_email',
      arguments: { prefix: 'ci', after_id: 2, timeout_seconds: 5 },
    });
    const waitPayload = waitRes.structuredContent as {
      found: boolean;
      cursor: number;
      email: { id: number; untrusted: { code_candidates: string[] } };
    };
    expect(waitPayload.found).toBe(true);
    expect(waitPayload.cursor).toBe(3);
    expect(waitPayload.email.untrusted.code_candidates).toContain('554433');

    // Verify audit logs recorded agent reads with actor='agent'
    expect(store.auditLogs.some((l) => l.actor === 'agent' && l.action === 'mcp.email.read')).toBe(true);
    expect(store.auditLogs.some((l) => l.actor === 'agent' && l.action === 'mcp.email.wait_hit')).toBe(true);

    await client.close();
  });

  it('enforces auth, origin, method, kill switch, and batch restrictions at HTTP layer', async () => {
    const store = createInMemoryMcpDb();
    const { token } = await store.issueToken();
    const mcpApp = new Hono<{ Bindings: Env }>();
    mcpApp.route('/mcp', createMcpRoutes());
    const env = { DB: store.db } as Env;

    // Missing token -> 401 with WWW-Authenticate
    const unauth = await mcpApp.fetch(new Request('https://mail.example.com/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }), env);
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('WWW-Authenticate')).toContain('Bearer');

    // Cross-origin -> 403; same-origin -> 200
    // (happy-dom's Request strips forbidden header `Origin`, so attach incoming server headers directly)
    const requestWithOrigin = (origin: string) => {
      const req = new Request('https://mail.example.com/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      const headers = new Headers(req.headers);
      headers.set('Origin', origin);
      Object.defineProperty(req, 'headers', { value: headers });
      return req;
    };

    const badOriginReq = requestWithOrigin('https://evil.example.net');
    expect(badOriginReq.headers.get('Origin')).toBe('https://evil.example.net');
    const badOrigin = await mcpApp.fetch(badOriginReq, env);
    expect(badOrigin.status).toBe(403);

    const sameOrigin = await mcpApp.fetch(requestWithOrigin('https://mail.example.com'), env);
    expect(sameOrigin.status).toBe(200);

    // GET / DELETE -> 405
    const getRes = await mcpApp.fetch(new Request('https://mail.example.com/mcp', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }), env);
    expect(getRes.status).toBe(405);
    expect(getRes.headers.get('Allow')).toBe('POST');

    // Batch request -> -32600
    const batchRes = await mcpApp.fetch(new Request('https://mail.example.com/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]),
    }), env);
    expect(batchRes.status).toBe(400);
    const batchBody = await batchRes.json<{ error: { code: number } }>();
    expect(batchBody.error.code).toBe(-32600);

    // Global kill switch -> 403
    store.settings.mcp_enabled = '0';
    const disabled = await mcpApp.fetch(new Request('https://mail.example.com/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }), env);
    expect(disabled.status).toBe(403);
  });

  it('enforces send_email & reply_email allowlist, exact prefix, idempotency, and two-tier rate limits', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ id: `re_msg_${fetchMock.mock.calls.length}` }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const store = createInMemoryMcpDb({
      settings: { mcp_daily_send_limit: '2' },
      emails: [
        makeEmail({
          id: 10,
          from_addr: 'Alice <alice@example.com>',
          to_addr: 'ci+support@example.com',
          to_prefix: 'ci+support',
          subject: 'Need status',
          raw_body: [
            'From: Alice <alice@example.com>',
            'Reply-To: alice@example.com',
            'Message-ID: <alice-10@example.com>',
            '',
            'Any update?',
          ].join('\r\n'),
        }),
      ],
    });

    const { token } = await store.issueToken({
      name: 'Claude Sender',
      scopes: ['mail:read', 'mail:send'],
      prefixes: ['ci'],
      allowPlusTags: true,
      recipientPolicy: 'allowlist',
      recipientAllowlist: ['alice@example.com'],
      sendLimitHour: 10,
      sendLimitDay: 10,
    });

    const mcpApp = new Hono<{ Bindings: Env }>();
    mcpApp.route('/mcp', createMcpRoutes());

    const callTool = async (name: string, args: Record<string, unknown>) => {
      const res = await mcpApp.fetch(new Request('https://mail.example.com/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      }), { DB: store.db } as Env);
      const body = await res.json<{ result: { isError?: boolean; structuredContent: Record<string, unknown> } }>();
      return body.result;
    };

    // 1. Rejects non-allowlisted recipient
    const blockedRecipient = await callTool('send_email', {
      from_prefix: 'ci',
      to: 'attacker@evil.com',
      subject: 'Leak',
      text: 'Secret',
      idempotency_key: 'k-block-1',
    });
    expect(blockedRecipient.isError).toBe(true);
    expect(blockedRecipient.structuredContent.code).toBe('FORBIDDEN_RECIPIENT');

    // 2. Rejects +tag on outbound send (exact match required)
    const blockedPlusSend = await callTool('send_email', {
      from_prefix: 'ci+tag',
      to: 'alice@example.com',
      subject: 'Hi',
      text: 'Hello',
      idempotency_key: 'k-block-2',
    });
    expect(blockedPlusSend.isError).toBe(true);
    expect(blockedPlusSend.structuredContent.code).toBe('FORBIDDEN_PREFIX');

    // 3. Valid send succeeds and replays cleanly on same idempotency_key
    const firstSend = await callTool('send_email', {
      from_prefix: 'ci',
      to: 'alice@example.com',
      subject: 'Build passed',
      text: 'All green!',
      idempotency_key: 'idem-build-1',
    });
    expect(firstSend.isError).toBeFalsy();
    expect(firstSend.structuredContent.replayed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const replaySend = await callTool('send_email', {
      from_prefix: 'ci',
      to: 'alice@example.com',
      subject: 'Build passed',
      text: 'All green!',
      idempotency_key: 'idem-build-1',
    });
    expect(replaySend.isError).toBeFalsy();
    expect(replaySend.structuredContent.replayed).toBe(true);
    expect(replaySend.structuredContent.sent_id).toBe(firstSend.structuredContent.sent_id);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 4. Same idempotency_key with different body -> IDEMPOTENCY_CONFLICT
    const conflictSend = await callTool('send_email', {
      from_prefix: 'ci',
      to: 'alice@example.com',
      subject: 'Different subject',
      text: 'Different body',
      idempotency_key: 'idem-build-1',
    });
    expect(conflictSend.isError).toBe(true);
    expect(conflictSend.structuredContent.code).toBe('IDEMPOTENCY_CONFLICT');

    // 5. reply_email strips +support -> ci, threads headers, and uses quota 2/2
    const replyRes = await callTool('reply_email', {
      email_id: 10,
      text: 'Status is green.',
      idempotency_key: 'idem-reply-10',
    });
    expect(replyRes.isError).toBeFalsy();
    expect(replyRes.structuredContent.from).toBe('ci@mail.example.com');
    expect(replyRes.structuredContent.reply_to).toBe('ci@example.com');
    expect(replyRes.structuredContent.subject).toBe('Re: Need status');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sentPayload = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(sentPayload.headers).toEqual({
      'In-Reply-To': '<alice-10@example.com>',
      References: '<alice-10@example.com>',
    });

    // 6. 3rd send hits instance-wide daily limit (2/2)
    const rateLimited = await callTool('send_email', {
      from_prefix: 'ci',
      to: 'alice@example.com',
      subject: 'Over cap',
      text: 'Should be blocked',
      idempotency_key: 'idem-over-cap',
    });
    expect(rateLimited.isError).toBe(true);
    expect(rateLimited.structuredContent.code).toBe('RATE_LIMITED');

    // 7. list_sent_emails returns the 2 sent emails
    const sentList = await callTool('list_sent_emails', {});
    expect(sentList.isError).toBeFalsy();
    expect((sentList.structuredContent.emails as unknown[]).length).toBe(2);

    // 8. Admin API can revoke token and immediately lock out MCP access
    const revokeRes = await mcpAdminRoutes.request('/tokens/1/revoke', {
      method: 'POST',
    }, { DB: store.db } as Env);
    expect(revokeRes.status).toBe(200);

    const afterRevoke = await mcpApp.fetch(new Request('https://mail.example.com/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    }), { DB: store.db } as Env);
    expect(afterRevoke.status).toBe(401);
  });
});
