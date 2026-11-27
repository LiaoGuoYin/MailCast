import { Hono } from 'hono';
import { requestIp } from '../audit';
import { touchAgentTokenUsage, verifyAgentToken } from '../auth/agent-token';
import { getMcpSettings } from '../settings';
import type { Env } from '../types';
import {
  executeMcpTool,
  findToolDefinition,
  listToolsForPrincipal,
  MCP_SERVER_INSTRUCTIONS,
  type McpExecutionOptions,
} from './tools';

const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'mailcast', version: '0.1.0' };

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function jsonRpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
) {
  return {
    jsonrpc: '2.0' as const,
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

function extractBearerToken(header: string | undefined): string {
  if (!header) return '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function isOriginAllowed(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function negotiateProtocolVersion(requested: unknown): string {
  if (
    typeof requested === 'string'
    && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
  ) {
    return requested;
  }
  return DEFAULT_PROTOCOL_VERSION;
}

export interface CreateMcpRoutesOptions {
  sleep?: McpExecutionOptions['sleep'];
  pollIntervalMs?: number;
  now?: McpExecutionOptions['now'];
}

export function createMcpRoutes(options: CreateMcpRoutesOptions = {}) {
  const mcp = new Hono<{ Bindings: Env }>();

  mcp.all('/', async (c) => {
    if (!isOriginAllowed(c.req.raw)) {
      return c.json({ error: 'Forbidden origin' }, 403);
    }

    const method = c.req.method.toUpperCase();
    if (method === 'GET' || method === 'DELETE') {
      return c.json(
        { error: 'Method Not Allowed. This MCP endpoint operates in stateless POST mode.' },
        405,
        { Allow: 'POST' },
      );
    }
    if (method !== 'POST') {
      return c.json({ error: 'Method Not Allowed' }, 405, { Allow: 'POST' });
    }

    const rawToken = extractBearerToken(c.req.header('Authorization'));
    const principal = rawToken ? await verifyAgentToken(c.env.DB, rawToken) : null;
    if (!principal) {
      return c.json(
        { error: 'Unauthorized' },
        401,
        { 'WWW-Authenticate': 'Bearer realm="mailcast-mcp"' },
      );
    }

    const mcpSettings = await getMcpSettings(c.env.DB);
    if (!mcpSettings.enabled) {
      return c.json({ error: 'MCP access is disabled by administrator' }, 403);
    }

    const ipAddress = requestIp(c.req.raw);
    const touchPromise = touchAgentTokenUsage(c.env.DB, principal.tokenId, ipAddress)
      .catch(() => undefined);
    try {
      c.executionCtx.waitUntil(touchPromise);
    } catch {
      // Tests calling app.request() directly do not attach an ExecutionContext.
      await touchPromise;
    }

    const contentType = c.req.header('Content-Type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return c.json(
        jsonRpcError(null, -32600, 'Content-Type must be application/json'),
        400,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json<unknown>();
    } catch {
      return c.json(jsonRpcError(null, -32700, 'Parse error'), 400);
    }

    if (Array.isArray(body)) {
      return c.json(
        jsonRpcError(null, -32600, 'Batch requests are not supported'),
        400,
      );
    }

    if (!body || typeof body !== 'object') {
      return c.json(jsonRpcError(null, -32600, 'Invalid Request'), 400);
    }

    const rpc = body as Partial<JsonRpcRequest>;
    if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' || !rpc.method) {
      const id = typeof rpc.id === 'string' || typeof rpc.id === 'number' ? rpc.id : null;
      return c.json(jsonRpcError(id, -32600, 'Invalid Request'), 400);
    }

    // JSON-RPC notifications have no `id` and expect 202 Accepted with an empty body.
    if (rpc.id === undefined) {
      return c.body(null, 202);
    }

    const id = typeof rpc.id === 'string' || typeof rpc.id === 'number' || rpc.id === null
      ? rpc.id
      : null;
    const params = rpc.params && typeof rpc.params === 'object' && !Array.isArray(rpc.params)
      ? rpc.params
      : {};

    try {
      switch (rpc.method) {
        case 'initialize': {
          const protocolVersion = negotiateProtocolVersion(params.protocolVersion);
          return c.json(
            jsonRpcResult(id, {
              protocolVersion,
              capabilities: {
                tools: { listChanged: false },
              },
              serverInfo: SERVER_INFO,
              instructions: MCP_SERVER_INSTRUCTIONS,
            }),
            200,
            { 'MCP-Protocol-Version': protocolVersion },
          );
        }

        case 'ping': {
          return c.json(jsonRpcResult(id, {}));
        }

        case 'tools/list': {
          return c.json(jsonRpcResult(id, {
            tools: listToolsForPrincipal(principal),
          }));
        }

        case 'tools/call': {
          const toolName = typeof params.name === 'string' ? params.name : '';
          if (!toolName) {
            return c.json(jsonRpcError(id, -32602, 'Invalid params: missing tool name'));
          }
          if (!findToolDefinition(toolName)) {
            return c.json(jsonRpcError(id, -32602, `Unknown tool: ${toolName}`));
          }
          const toolArgs = params.arguments === undefined
            ? {}
            : params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
              ? (params.arguments as Record<string, unknown>)
              : null;
          if (toolArgs === null) {
            return c.json(jsonRpcError(id, -32602, 'Invalid params: arguments must be an object'));
          }

          const result = await executeMcpTool(c.env, principal, toolName, toolArgs, {
            ipAddress,
            sleep: options.sleep,
            pollIntervalMs: options.pollIntervalMs,
            now: options.now,
          });
          return c.json(jsonRpcResult(id, result));
        }

        default:
          return c.json(jsonRpcError(id, -32601, `Method not found: ${rpc.method}`));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal error';
      console.error(JSON.stringify({
        message: 'mcp request failed',
        method: rpc.method,
        token_id: principal.tokenId,
        error: message,
      }));
      return c.json(jsonRpcError(id, -32603, 'Internal error'), 500);
    }
  });

  return mcp;
}

export const mcpRoutes = createMcpRoutes();
