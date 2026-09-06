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
import type { Env } from './types';

type AppBindings = { Bindings: Env };

const app = new Hono<AppBindings>();

app.use('/api/*', cors());
app.route('/api/auth', authRoutes);
app.route('/api/meta', metaRoutes);

// API routes (auth required)
const api = new Hono<AppBindings>();
api.use('*', authMiddleware);
api.route('/emails', emailRoutes);
api.route('/rules', ruleRoutes);
api.route('/settings', settingsRoutes);
api.route('/logs', logRoutes);
api.route('/destinations', destinationRoutes);
app.route('/api', api);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
  email: handleEmail,
};
