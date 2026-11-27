import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { handleEmail } from './email/handler';
import { authMiddleware, authRoutes } from './api/auth';
import { emailRoutes } from './api/emails';
import { ruleRoutes } from './api/rules';
import { settingsRoutes } from './api/settings';
import { logRoutes } from './api/logs';
import { destinationRoutes } from './api/destinations';
import { metaRoutes } from './api/meta';
import { setupRoutes } from './api/setup';
import { outboundRoutes } from './api/outbound';
import { mcpAdminRoutes } from './api/mcp-admin';
import { mcpRoutes } from './mcp/handler';
import type { Env } from './types';

type AppBindings = { Bindings: Env };

export const app = new Hono<AppBindings>();

// MCP endpoint (outside /api/* so it does not inherit wildcard CORS or admin session middleware)
app.route('/mcp', mcpRoutes);

app.use('/api/*', cors());
app.route('/api/auth', authRoutes);
app.route('/api/meta', metaRoutes);

// API routes (auth required)
const api = new Hono<AppBindings>();
api.use('*', authMiddleware);
api.route('/emails', emailRoutes);
api.route('/outbound', outboundRoutes);
api.route('/rules', ruleRoutes);
api.route('/settings/mcp', mcpAdminRoutes);
api.route('/settings', settingsRoutes);
api.route('/logs', logRoutes);
api.route('/destinations', destinationRoutes);
api.route('/setup', setupRoutes);
app.route('/api', api);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
  email: handleEmail,
};
