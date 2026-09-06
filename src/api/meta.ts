import { Hono } from 'hono';
import type { Env } from '../types';

const VERSION_TAG_PATTERN = /^mailcast-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)-([0-9a-f]{12})$/;

export interface AppMetadata {
  app_version: string | null;
  commit: string | null;
  deployed_at: string | null;
  deployment_id: string | null;
}

export function parseVersionTag(tag: string): Pick<AppMetadata, 'app_version' | 'commit'> {
  const match = VERSION_TAG_PATTERN.exec(tag);
  return match
    ? { app_version: match[1], commit: match[2] }
    : { app_version: null, commit: null };
}

export const metaRoutes = new Hono<{ Bindings: Env }>();

metaRoutes.get('/', (c) => {
  const metadata = c.env.CF_VERSION_METADATA;
  c.header('Cache-Control', 'no-store');
  return c.json(metadata ? {
    ...parseVersionTag(metadata.tag),
    deployed_at: metadata.timestamp,
    deployment_id: metadata.id,
  } satisfies AppMetadata : {
    app_version: null,
    commit: null,
    deployed_at: null,
    deployment_id: null,
  } satisfies AppMetadata);
});
