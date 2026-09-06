import { describe, expect, it } from 'vitest';
import {
  assertCleanWorkingTree,
  assertReservedArgsAvailable,
  buildVersionTag,
  deployArgsFrom,
  migrationArgs,
} from '../scripts/deploy.mjs';

describe('versioned deploy script', () => {
  it('builds a stable tag from semver and the current commit', () => {
    expect(buildVersionTag('0.1.0', '3C63981241EEC4678FD76B3C92EB08B9FA2C8792'))
      .toBe('mailcast-v0.1.0-3c63981241ee');
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
