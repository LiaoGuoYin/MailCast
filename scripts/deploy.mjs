import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VERSION_TAG_PREFIX = 'mailcast-v';
const SHORT_COMMIT_LENGTH = 12;
const GLOBAL_WRANGLER_OPTIONS = new Set([
  '-c', '--config', '--cwd', '-e', '--env', '--env-file', '--profile',
]);

export function buildVersionTag(version, commit) {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`package.json 中的版本号无效：${version}`);
  }
  const normalizedCommit = commit.trim().toLowerCase();
  if (!FULL_COMMIT_PATTERN.test(normalizedCommit)) {
    throw new Error('无法取得有效的 40 位 Git commit SHA，已取消部署。');
  }
  return `${VERSION_TAG_PREFIX}${version}-${normalizedCommit.slice(0, SHORT_COMMIT_LENGTH)}`;
}

export function migrationArgs(deployArgs) {
  const result = [];
  for (let index = 0; index < deployArgs.length; index += 1) {
    const argument = deployArgs[index];
    const option = argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument;
    if (!GLOBAL_WRANGLER_OPTIONS.has(option)) continue;
    result.push(argument);
    if (!argument.includes('=') && index + 1 < deployArgs.length) {
      result.push(deployArgs[index + 1]);
      index += 1;
    }
  }
  return result;
}

export function deployArgsFrom(rawArgs) {
  return rawArgs.filter((argument) => argument !== '--migrate' && argument !== '--');
}

export function assertReservedArgsAvailable(args) {
  if (args.some((argument) => argument === '--tag' || argument.startsWith('--tag='))) {
    throw new Error('版本 tag 由 MailCast 部署脚本生成，请勿手动传入 --tag。');
  }
  if (args.some((argument) => argument === '--message' || argument.startsWith('--message='))) {
    throw new Error('部署说明由 MailCast 部署脚本生成，请勿手动传入 --message。');
  }
}

export function assertCleanWorkingTree(status) {
  if (status.trim()) {
    throw new Error('工作区包含未提交改动，无法生成可信的线上版本标识；请先提交再部署。');
  }
}

function resolveCommit(projectRoot) {
  const ciCommit = process.env.WORKERS_CI_COMMIT_SHA?.trim().toLowerCase();
  if (ciCommit) return ciCommit;
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim().toLowerCase();
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  const wrangler = fileURLToPath(new URL('../node_modules/.bin/wrangler', import.meta.url));
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const rawArgs = process.argv.slice(2);
  const shouldMigrate = rawArgs.includes('--migrate');
  const deployArgs = deployArgsFrom(rawArgs);
  const dryRun = deployArgs.includes('--dry-run');
  const workersBuildCommit = process.env.WORKERS_CI_COMMIT_SHA?.trim();

  assertReservedArgsAvailable(deployArgs);
  if (!workersBuildCommit && !dryRun) {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    assertCleanWorkingTree(status);
  }
  const commit = resolveCommit(projectRoot);
  const tag = buildVersionTag(packageJson.version, commit);
  const shortCommit = commit.slice(0, SHORT_COMMIT_LENGTH);

  if (shouldMigrate && !dryRun) {
    const migrationExitCode = await run(wrangler, [
      'd1', 'migrations', 'apply', 'DB', '--remote', ...migrationArgs(deployArgs),
    ], projectRoot);
    if (migrationExitCode !== 0) process.exit(migrationExitCode);
  }

  console.log(`部署 MailCast v${packageJson.version} (${shortCommit})`);
  const exitCode = await run(wrangler, [
    'deploy', ...deployArgs,
    '--tag', tag,
    '--message', `MailCast v${packageJson.version} (${shortCommit})`,
  ], projectRoot);
  if (exitCode !== 0) process.exit(exitCode);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
