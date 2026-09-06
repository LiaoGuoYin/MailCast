const encoder = new TextEncoder();

export function authTokenProblem(token: unknown): string | null {
  if (typeof token !== 'string' || token.length < 8) return '密码长度至少 8 位';
  if (token.length > 256) return '密码长度不能超过 256 位';
  if (/\s/.test(token)) return '密码不能包含空白字符';
  return null;
}

export async function verifyAdminPassword(password: string, configuredPassword: string): Promise<boolean> {
  // Compare fixed-size digests without an early exit based on a matching prefix.
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(password)),
    crypto.subtle.digest('SHA-256', encoder.encode(configuredPassword)),
  ]);
  const left = new Uint8Array(actual);
  const right = new Uint8Array(expected);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}
