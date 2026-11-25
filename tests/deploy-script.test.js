import { describe, expect, it } from 'vitest';
import {
  assertCleanWorkingTree,
  assertReservedArgsAvailable,
  buildVersionTag,
  ciCommitFrom,
  configNameFrom,
  d1DatabaseIdFrom,
  deployArgsFrom,
  isTemplateMode,
  liveVersionIdFrom,
  migrationArgs,
  migrationConfigFor,
  resolveWorkerName,
  withWorkerName,
} from '../scripts/deploy.mjs';

describe('versioned deploy script', () => {
  it('builds a stable tag from semver and the current commit', () => {
    expect(buildVersionTag('0.1.0', '3C63981241EEC4678FD76B3C92EB08B9FA2C8792'))
      .toBe('mailcast-v0.1.0-3c63981241ee');
  });

  it('trusts only a full Workers Builds commit SHA', () => {
    const sha = '3C63981241EEC4678FD76B3C92EB08B9FA2C8792';
    expect(ciCommitFrom({ WORKERS_CI_COMMIT_SHA: sha })).toBe(sha.toLowerCase());
    expect(ciCommitFrom({ WORKERS_CI_COMMIT_SHA: '' })).toBeUndefined();
    expect(ciCommitFrom({ WORKERS_CI_COMMIT_SHA: '3c63981' })).toBeUndefined();
    expect(ciCommitFrom({})).toBeUndefined();
  });

  it('rejects deployments that cannot be tied to a full commit', () => {
    expect(() => buildVersionTag('0.1.0', '3c63981'))
      .toThrow('有效的 40 位 Git commit SHA');
  });

  it('forwards only global Wrangler options to D1 migrations', () => {
    expect(migrationArgs([
      '--config', '/tmp/production.toml', '--env=production', '--keep-vars', '--minify',
    ])).toEqual(['--config', '/tmp/production.toml', '--env=production']);
  });

  it('accepts conventional pnpm passthrough separators', () => {
    expect(deployArgsFrom(['--migrate', '--', '--config', 'production.toml']))
      .toEqual(['--config', 'production.toml']);
  });

  it('reserves version tag and message arguments', () => {
    expect(() => assertReservedArgsAvailable(['--tag=manual'])).toThrow('请勿手动传入 --tag');
    expect(() => assertReservedArgsAvailable(['--message', 'manual'])).toThrow('请勿手动传入 --message');
  });

  it('rejects an uncommitted manual production deploy', () => {
    expect(() => assertCleanWorkingTree(' M public/app.js\n'))
      .toThrow('请先提交再部署');
    expect(() => assertCleanWorkingTree('')).not.toThrow();
  });
});

describe('template-mode deploy', () => {
  it('uses template mode only without an instance config', () => {
    expect(isTemplateMode([])).toBe(true);
    expect(isTemplateMode(['--keep-vars'])).toBe(true);
    expect(isTemplateMode(['-c', 'wrangler.prod.toml'])).toBe(false);
    expect(isTemplateMode(['--config=wrangler.prod.toml'])).toBe(false);
  });

  it('prefers an explicit --name, then the Workers Builds override, then the config', () => {
    const config = '#:schema x\nname = "mailcast"\nmain = "src/index.ts"\n';
    expect(configNameFrom(config)).toBe('mailcast');
    expect(resolveWorkerName(['--name=a'], { WRANGLER_CI_OVERRIDE_NAME: 'b' }, config)).toBe('a');
    expect(resolveWorkerName([], { WRANGLER_CI_OVERRIDE_NAME: 'b' }, config)).toBe('b');
    expect(resolveWorkerName([], { WRANGLER_CI_OVERRIDE_NAME: ' ' }, config)).toBe('mailcast');
  });

  it('adds --name only when none was passed', () => {
    expect(withWorkerName(['--keep-vars'], 'mailcast-smoke'))
      .toEqual(['--keep-vars', '--name', 'mailcast-smoke']);
    expect(withWorkerName(['--name', 'x'], 'mailcast-smoke')).toEqual(['--name', 'x']);
  });

  it('picks the version serving the most traffic', () => {
    expect(liveVersionIdFrom({
      versions: [{ version_id: 'old', percentage: 10 }, { version_id: 'new', percentage: 90 }],
    })).toBe('new');
    expect(liveVersionIdFrom({ versions: [] })).toBeUndefined();
  });

  it('reads the DB binding database ID from a version', () => {
    const view = {
      resources: {
        bindings: [
          { name: 'AI', type: 'ai' },
          { name: 'OTHER', type: 'd1', database_id: 'other-id' },
          { name: 'DB', type: 'd1', database_id: 'db-id' },
        ],
      },
    };
    expect(d1DatabaseIdFrom(view)).toBe('db-id');
    expect(d1DatabaseIdFrom({ resources: { bindings: [] } })).toBeUndefined();
  });

  it('writes a minimal migration config for the live database', () => {
    expect(migrationConfigFor({
      workerName: 'mailcast-smoke',
      databaseId: '854de628-6703-4a0a-8836-c8ca988a7eec',
      migrationsDir: '/repo/migrations',
    })).toBe([
      'name = "mailcast-smoke"',
      '',
      '[[d1_databases]]',
      'binding = "DB"',
      'database_id = "854de628-6703-4a0a-8836-c8ca988a7eec"',
      'migrations_dir = "/repo/migrations"',
      '',
    ].join('\n'));
  });
});
