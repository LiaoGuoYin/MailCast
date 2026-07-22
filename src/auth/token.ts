const HASH_ALGORITHM = 'PBKDF2';
const HASH_DIGEST = 'SHA-256';
const HASH_VERSION = 'pbkdf2-sha256';
const HASH_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

const encoder = new TextEncoder();

export function authTokenProblem(token: string): string | null {
  if (token.length < 8) return '密码长度至少 8 位';
  if (token.length > 256) return '密码长度不能超过 256 位';
  if (/\s/.test(token)) return '密码不能包含空白字符';
  return null;
}

export async function hashAuthToken(token: string): Promise<string> {
  const problem = authTokenProblem(token);
  if (problem) throw new Error(problem);

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await deriveToken(token, salt, HASH_ITERATIONS);
  return [
    HASH_VERSION,
    String(HASH_ITERATIONS),
    encodeBase64Url(salt),
    encodeBase64Url(derived),
  ].join('$');
}

export async function verifyAuthToken(token: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== HASH_VERSION) return false;

  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations !== HASH_ITERATIONS) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = decodeBase64Url(parts[2]);
    expected = decodeBase64Url(parts[3]);
  } catch {
    return false;
  }
  if (salt.byteLength !== SALT_BYTES || expected.byteLength !== HASH_BYTES) return false;

  const actual = await deriveToken(token, salt, iterations);
  return constantTimeEqual(actual, expected);
}

async function deriveToken(
  token: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(token),
    HASH_ALGORITHM,
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: HASH_ALGORITHM, hash: HASH_DIGEST, salt, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid base64url value');
  }
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
