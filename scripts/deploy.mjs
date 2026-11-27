import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VERSION_TAG_PREFIX = 'mailcast-v';
const SHORT_COMMIT_LENGTH = 12;
const GLOBAL_WRANGLER_OPTIONS = new Set([
  '-c', '--config', '--cwd', '-e', '--env', '--env-file', '--profile',
]);
const CONFIG_OPTIONS = new Set(['-c', '--config']);
const D1_BINDING = 'DB';
// Cloudflare API error code for "This Worker does not exist on your account".
const WORKER_NOT_FOUND_CODE = 'code: 10007';

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

function optionName(argument) {
  return argument.includes('=') ? argument.slice(0, argument.indexOf('=')) : argument;
}

// Template mode: deploying with the public, instance-agnostic wrangler.toml
// (Workers Builds, or a manual deploy without an instance config). Passing
// -c keeps the instance-config path exactly as before.
export function isTemplateMode(deployArgs) {
  return !deployArgs.some((argument) => CONFIG_OPTIONS.has(optionName(argument)));
}

export function nameArgFrom(deployArgs) {
  for (let index = 0; index < deployArgs.length; index += 1) {
    const argument = deployArgs[index];
    if (argument.startsWith('--name=')) return argument.slice('--name='.length);
    if (argument === '--name') return deployArgs[index + 1];
  }
  return undefined;
}

export function configNameFrom(configText) {
  return configText.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
}

export function resolveWorkerName(deployArgs, env, configText) {
  return nameArgFrom(deployArgs)
    || env.WRANGLER_CI_OVERRIDE_NAME?.trim()
    || configNameFrom(configText);
}

// Workers Builds opens a "fix name mismatch" PR whenever the config name
// differs from the connected Worker. An explicit --name makes Wrangler deploy
// under the real Worker name without reporting a mismatch.
export function withWorkerName(deployArgs, workerName) {
  if (nameArgFrom(deployArgs) !== undefined) return deployArgs;
  return [...deployArgs, '--name', workerName];
}

export function liveVersionIdFrom(deploymentStatus) {
  const versions = deploymentStatus?.versions ?? [];
  const live = versions.reduce(
    (best, version) => (!best || version.percentage > best.percentage ? version : best),
    undefined,
  );
  return live?.version_id;
}

export function d1DatabaseIdFrom(versionView, binding = D1_BINDING) {
  const bindings = versionView?.resources?.bindings ?? [];
  return bindings.find((item) => item.type === 'd1' && item.name === binding)?.database_id;
}

// `d1 migrations apply` only resolves databases declared in the config, and
// the template intentionally omits the instance's database ID. This minimal
// config points migrations at the database the live Worker is bound to.
export function migrationConfigFor({ workerName, databaseId, migrationsDir }) {
  return [
    `name = ${JSON.stringify(workerName)}`,
    '',
    '[[d1_databases]]',
    `binding = ${JSON.stringify(D1_BINDING)}`,
    `database_id = ${JSON.stringify(databaseId)}`,
    `migrations_dir = ${JSON.stringify(migrationsDir)}`,
    '',
  ].join('\n');
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

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

// Manually triggered Workers Builds pass no usable commit SHA, so only a full
// SHA is trusted; otherwise read HEAD of the checked-out repository.
export function ciCommitFrom(env) {
  const ciCommit = env.WORKERS_CI_COMMIT_SHA?.trim().toLowerCase();
  return ciCommit && FULL_COMMIT_PATTERN.test(ciCommit) ? ciCommit : undefined;
}

function resolveCommit(projectRoot) {
  return ciCommitFrom(process.env)
    ?? runGit(['rev-parse', 'HEAD'], projectRoot).trim().toLowerCase();
}

function captureWrangler(wrangler, args, cwd) {
  try {
    const stdout = execFileSync(wrangler, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

// Returns null when the Worker has no D1 yet: it does not exist, or it was
// created in the dashboard (for example to set ADMIN_PASSWORD) without a DB
// binding. Either way the next deploy provisions the database.
function findLiveDatabaseId(wrangler, workerName, cwd) {
  const status = captureWrangler(
    wrangler, ['deployments', 'status', '--name', workerName, '--json'], cwd,
  );
  if (!status.ok) {
    if (status.output.includes(WORKER_NOT_FOUND_CODE)) return null;
    throw new Error(`无法读取 Worker ${workerName} 的线上部署：\n${status.output}`);
  }
  const versionId = liveVersionIdFrom(JSON.parse(status.stdout));
  if (!versionId) return null;

  const view = captureWrangler(
    wrangler, ['versions', 'view', versionId, '--name', workerName, '--json'], cwd,
  );
  if (!view.ok) throw new Error(`无法读取 Worker ${workerName} 的版本 ${versionId}：\n${view.output}`);
  return d1DatabaseIdFrom(JSON.parse(view.stdout)) ?? null;
}

async function migrateLiveDatabase(wrangler, workerName, databaseId, projectRoot) {
  const configDir = join(projectRoot, '.wrangler', 'deploy');
  const configPath = join(configDir, 'migrate.toml');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, migrationConfigFor({
    workerName,
    databaseId,
    migrationsDir: join(projectRoot, 'migrations'),
  }));
  console.log(`迁移 ${workerName} 的 D1 数据库 (${databaseId})`);
  try {
    return await run(wrangler, [
      'd1', 'migrations', 'apply', D1_BINDING, '--remote', '--config', configPath,
    ], projectRoot);
  } finally {
    rmSync(configPath, { force: true });
  }
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
  // Workers Builds sets WORKERS_CI; its fresh checkout is clean by definition.
  const inWorkersBuild = Boolean(process.env.WORKERS_CI || process.env.WORKERS_CI_COMMIT_SHA);

  assertReservedArgsAvailable(deployArgs);
  if (!inWorkersBuild && !dryRun) {
    const status = runGit(['status', '--porcelain'], projectRoot);
    assertCleanWorkingTree(status);
  }
  const commit = resolveCommit(projectRoot);
  const tag = buildVersionTag(packageJson.version, commit);
  const shortCommit = commit.slice(0, SHORT_COMMIT_LENGTH);

  const templateMode = isTemplateMode(deployArgs);
  const workerName = templateMode
    ? resolveWorkerName(
      deployArgs,
      process.env,
      readFileSync(join(projectRoot, 'wrangler.toml'), 'utf8'),
    )
    : undefined;
  if (templateMode && !workerName) throw new Error('无法确定要部署的 Worker 名称。');
  const finalDeployArgs = templateMode ? withWorkerName(deployArgs, workerName) : deployArgs;
  const exitOnFailure = (exitCode) => {
    if (exitCode !== 0) process.exit(exitCode);
  };
  const deploy = async () => {
    console.log(`部署 MailCast v${packageJson.version} (${shortCommit})`);
    exitOnFailure(await run(wrangler, [
      'deploy', ...finalDeployArgs,
      '--tag', tag,
      '--message', `MailCast v${packageJson.version} (${shortCommit})`,
    ], projectRoot));
  };
  const migrate = async (databaseId) => {
    exitOnFailure(await migrateLiveDatabase(wrangler, workerName, databaseId, projectRoot));
  };

  // The console's JS is compiled from web/ and is not committed. wrangler.toml
  // builds it through [build], but the per-instance configs passed with -c
  // have no [build] section, so build here as well: every deploy then ships
  // freshly compiled assets, and a type error stops it before any migration.
  console.log('编译控制台前端');
  exitOnFailure(await run(process.execPath, [
    fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)),
    '-p', 'tsconfig.web.json',
  ], projectRoot));

  if (!shouldMigrate || dryRun) return deploy();

  if (!templateMode) {
    exitOnFailure(await run(wrangler, [
      'd1', 'migrations', 'apply', D1_BINDING, '--remote', ...migrationArgs(deployArgs),
    ], projectRoot));
    return deploy();
  }

  const existingDatabaseId = findLiveDatabaseId(wrangler, workerName, projectRoot);
  if (existingDatabaseId) {
    await migrate(existingDatabaseId);
    return deploy();
  }

  // New instance: there is no database to migrate yet. The first deploy lets
  // Wrangler provision D1 for the binding, then migrations run against it.
  console.log(`Worker ${workerName} 尚未绑定 D1，先部署以创建数据库，再执行迁移`);
  await deploy();
  const createdDatabaseId = findLiveDatabaseId(wrangler, workerName, projectRoot);
  if (!createdDatabaseId) throw new Error(`部署后仍找不到 Worker ${workerName} 的 ${D1_BINDING} 绑定。`);
  await migrate(createdDatabaseId);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
