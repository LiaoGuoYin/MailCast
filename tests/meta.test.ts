import { describe, expect, it } from 'vitest';
import { metaRoutes, parseVersionTag } from '../src/api/meta';
import type { Env } from '../src/types';

describe('app metadata', () => {
  it('parses a tagged MailCast deployment', () => {
    expect(parseVersionTag('mailcast-v0.1.0-3c63981241ee')).toEqual({
      app_version: '0.1.0',
      commit: '3c63981241ee',
    });
  });

  it('treats unrecognized version tags as unmarked builds', () => {
    expect(parseVersionTag('production')).toEqual({
      app_version: null,
      commit: null,
    });
  });

  it('returns Cloudflare deployment identity without authentication', async () => {
    const response = await metaRoutes.request('/', {}, {
      CF_VERSION_METADATA: {
        id: 'deployment-id',
        tag: 'mailcast-v0.1.0-3c63981241ee',
        timestamp: '2026-08-03T12:00:00.000Z',
      },
    } as Env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      app_version: '0.1.0',
      commit: '3c63981241ee',
      deployed_at: '2026-08-03T12:00:00.000Z',
      deployment_id: 'deployment-id',
    });
  });

  it('degrades safely when an isolated config omits version metadata', async () => {
    const response = await metaRoutes.request('/', {}, {} as Env);

    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      app_version: null,
      commit: null,
      deployed_at: null,
      deployment_id: null,
    });
  });
});
