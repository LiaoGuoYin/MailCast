import { spawn } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HASH_VERSION = 'pbkdf2-sha256';
const HASH_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

const mode = process.argv[2];
const extraArgs = process.argv.slice(3);
const validPersistArgs = mode === '--local'
  && extraArgs.length === 2
  && extraArgs[0] === '--persist-to'
  && Boolean(extraArgs[1]);
if ((mode !== '--local' && mode !== '--remote') || (extraArgs.length > 0 && !validPersistArgs)) {
  console.error(
    'Usage: node scripts/set-auth-token.mjs --remote | --local [--persist-to <directory>]',
  );
  process.exit(1);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('This command requires an interactive terminal so the password is not exposed.');
  process.exit(1);
}

try {
  const token = await readSecret('管理密码: ');
  const problem = authTokenProblem(token);
  if (problem) throw new Error(problem);

  const confirmation = await readSecret('再次输入: ');
  if (token !== confirmation) throw new Error('两次输入的密码不一致');

  const hash = await hashAuthToken(token);
  const sql = `INSERT INTO settings (key, value) VALUES ('auth_token', '${escapeSql(hash)}') `
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value';
  const wrangler = fileURLToPath(new URL('../node_modules/.bin/wrangler', import.meta.url));
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  const exitCode = await run(
    wrangler,
    ['d1', 'execute', 'DB', mode, ...extraArgs, '--command', sql],
    projectRoot,
  );
  if (exitCode !== 0) process.exit(exitCode);
  console.log(`管理密码已写入${mode === '--remote' ? '远程' : '本地'} D1。`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function authTokenProblem(token) {
  if (token.length < 8) return '密码长度至少 8 位';
  if (token.length > 256) return '密码长度不能超过 256 位';
  if (/\s/.test(token)) return '密码不能包含空白字符';
  return null;
}

async function hashAuthToken(token) {
  const salt = webcrypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await webcrypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: HASH_ITERATIONS },
    key,
    HASH_BYTES * 8,
  );
  return [
    HASH_VERSION,
    String(HASH_ITERATIONS),
    encodeBase64Url(salt),
    encodeBase64Url(new Uint8Array(bits)),
  ].join('$');
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function escapeSql(value) {
  return value.replaceAll("'", "''");
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const wasRaw = input.isRaw;
    let value = '';

    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      process.stdout.write('\n');
    };

    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('已取消'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= ' ') value += character;
      }
    };

    process.stdout.write(prompt);
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}
