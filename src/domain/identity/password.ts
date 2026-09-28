/**
 * 邮箱认证的密码哈希：PBKDF2-SHA256（100,000 轮）+ 每用户随机盐。
 *
 * 与上游的差异：上游用 bcrypt。这里换算法的原因是**运行时可用的原语**——
 * workerd 只提供 WebCrypto，没有 bcrypt；引入纯 JS 的 bcrypt 会把认证热路径的
 * CPU 时间推到大几十毫秒，在 Worker 的 CPU 预算里代价过高。
 *
 * 这个差异**不影响对外可观测行为**：客户端永远只发明文密码，哈希形态是我们的内部状态。
 * 已登记为偏差（见 docs/ecn/ECN-0002）。
 *
 * 存储格式：`pbkdf2-sha256$<iterations>$<salt-b64url>$<hash-b64url>`。
 * 带上算法与轮数是为了将来换参数时能识别旧记录，而不是把所有用户锁在门外。
 */

const ALGORITHM = "pbkdf2-sha256";
const DEFAULT_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = DEFAULT_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations);
  return `${ALGORITHM}$${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/** 恒时比较，避免用 `===` 泄露前缀信息。 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= (a[index] as number) ^ (b[index] as number);
  }
  return diff === 0;
}

/** 校验失败一律返回 false（调用方映射成上游的 `401 Invalid credentials.`）。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4) return false;
  const [algorithm, rawIterations, rawSalt, rawHash] = parts as [string, string, string, string];
  if (algorithm !== ALGORITHM) return false;
  const iterations = Number.parseInt(rawIterations, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  try {
    const expected = fromBase64Url(rawHash);
    const actual = await derive(password, fromBase64Url(rawSalt), iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
