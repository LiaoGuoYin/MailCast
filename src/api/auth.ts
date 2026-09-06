import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import {
  createAdminSession,
  deleteAdminSession,
  verifyAdminSession,
} from '../auth/session';
import {
  authTokenProblem,
  verifyAdminPassword,
} from '../auth/token';
import { requestIp, safeRecordAuditLog } from '../audit';
import type { Env } from '../types';

export const authRoutes = new Hono<{ Bindings: Env }>();

export const authMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const token = bearerToken(c.req.header('Authorization'));
  if (authTokenProblem(c.env.ADMIN_PASSWORD) || !token
    || !await verifyAdminSession(c.env.DB, token, c.env.ADMIN_PASSWORD)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
});

authRoutes.post('/login', async (c) => {
  const configuredPassword = c.env.ADMIN_PASSWORD;
  if (authTokenProblem(configuredPassword)) {
    return c.json({
      error: '请在 Cloudflare 的 Variables and Secrets 中配置有效的 ADMIN_PASSWORD Secret（8–256 位，不含空白字符），保存并部署。',
      code: 'ADMIN_PASSWORD_NOT_CONFIGURED',
    }, 503);
  }
  const body = await c.req.json<{ password?: unknown }>().catch(() => null);
  const password = body?.password;
  if (typeof password !== 'string' || authTokenProblem(password)
    || !await verifyAdminPassword(password, configuredPassword)) {
    await safeRecordAuditLog(c.env.DB, {
      category: 'auth', action: 'auth.login', status: 'failed', actor: 'admin',
      summary: '管理后台登录失败', ipAddress: requestIp(c.req.raw),
    });
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const session = await createAdminSession(c.env.DB, configuredPassword);
  await safeRecordAuditLog(c.env.DB, {
    category: 'auth', action: 'auth.login', status: 'success', actor: 'admin',
    summary: '管理员登录成功', ipAddress: requestIp(c.req.raw),
  });
  return c.json(session);
});

authRoutes.post('/logout', authMiddleware, async (c) => {
  const token = bearerToken(c.req.header('Authorization'));
  if (token) await deleteAdminSession(c.env.DB, token, c.env.ADMIN_PASSWORD);
  await safeRecordAuditLog(c.env.DB, {
    category: 'auth', action: 'auth.logout', status: 'success', actor: 'admin',
    summary: '管理员退出登录', ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true });
});

function bearerToken(header: string | undefined): string {
  return header?.startsWith('Bearer ') ? header.slice(7) : '';
}
