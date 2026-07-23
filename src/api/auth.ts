import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import {
  createAdminSession,
  deleteAdminSession,
  initializeAdminCredentials,
  verifyAdminSession,
} from '../auth/session';
import {
  authTokenProblem,
  hashAuthToken,
  verifyAuthToken,
} from '../auth/token';
import { getAuthTokenHash } from '../settings';
import { requestIp, safeRecordAuditLog } from '../audit';
import type { Env } from '../types';

export const authRoutes = new Hono<{ Bindings: Env }>();
export const DEFAULT_INITIAL_PASSWORD = 'mailcast123';

export const authMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const token = bearerToken(c.req.header('Authorization'));
  if (!token || !await verifyAdminSession(c.env.DB, token)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
});

authRoutes.post('/login', async (c) => {
  const body = await c.req.json<{ password?: string; new_password?: string }>().catch(() => null);
  const password = body?.password?.trim() ?? '';
  const storedHash = await getAuthTokenHash(c.env.DB);

  if (!storedHash) {
    if (password !== DEFAULT_INITIAL_PASSWORD) {
      await safeRecordAuditLog(c.env.DB, {
        category: 'auth', action: 'auth.initialize', status: 'failed', actor: 'admin',
        summary: '管理员首次登录失败', ipAddress: requestIp(c.req.raw),
      });
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const newPassword = body?.new_password?.trim() ?? '';
    if (!newPassword) {
      return c.json({
        error: 'Password change required',
        code: 'PASSWORD_CHANGE_REQUIRED',
      }, 409);
    }
    const problem = authTokenProblem(newPassword);
    if (problem) return c.json({ error: problem }, 400);
    if (newPassword === DEFAULT_INITIAL_PASSWORD) {
      return c.json({ error: '新密码不能与默认初始密码相同' }, 400);
    }

    const session = await initializeAdminCredentials(c.env.DB, await hashAuthToken(newPassword));
    if (!session) {
      return c.json({
        error: 'Admin password is already initialized',
        code: 'ALREADY_INITIALIZED',
      }, 409);
    }
    await safeRecordAuditLog(c.env.DB, {
      category: 'auth', action: 'auth.initialize', status: 'success', actor: 'admin',
      summary: '管理员首次登录并完成强制改密', ipAddress: requestIp(c.req.raw),
    });
    return c.json(session, 201);
  }
  if (authTokenProblem(password) || !await verifyAuthToken(password, storedHash)) {
    await safeRecordAuditLog(c.env.DB, {
      category: 'auth', action: 'auth.login', status: 'failed', actor: 'admin',
      summary: '管理后台登录失败', ipAddress: requestIp(c.req.raw),
    });
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const session = await createAdminSession(c.env.DB);
  await safeRecordAuditLog(c.env.DB, {
    category: 'auth', action: 'auth.login', status: 'success', actor: 'admin',
    summary: '管理员登录成功', ipAddress: requestIp(c.req.raw),
  });
  return c.json(session);
});

authRoutes.post('/logout', authMiddleware, async (c) => {
  const token = bearerToken(c.req.header('Authorization'));
  if (token) await deleteAdminSession(c.env.DB, token);
  await safeRecordAuditLog(c.env.DB, {
    category: 'auth', action: 'auth.logout', status: 'success', actor: 'admin',
    summary: '管理员退出登录', ipAddress: requestIp(c.req.raw),
  });
  return c.json({ success: true });
});

function bearerToken(header: string | undefined): string {
  return header?.startsWith('Bearer ') ? header.slice(7) : '';
}
