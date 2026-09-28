/**
 * 会话令牌：HS256 JWT，与上游同一套 claim 名，另外加一个租户 claim。
 *
 * claim 一览（上游 `SessionTokenClaims` 的 json tag 加上本项目的 `gid`）：
 * - `tid` 令牌 id（UUIDv4 大写）——登出/吊销按它定位
 * - `uid` 用户 id
 * - `usn` 用户名
 * - `vrs` 自定义变量（上游 `account.vars`）
 * - `iat` / `exp` 签发与过期时间（Unix 秒）
 * - `gid` **租户 id**（本项目扩展，见 ECN-0001）。官方 SDK 把令牌当不透明串回传，
 *   所以多一个 claim 不影响兼容性；它让"已认证请求"不必再反查 server key 就知道租户。
 *
 * 签名密钥不是主密钥本身，而是 `deriveTenantSessionKey(master, tenantId)` 派生出来的
 * 每租户密钥——跨租户令牌在密码学层就不可能通过校验。
 */

export interface SessionClaims {
  readonly tid: string;
  readonly uid: string;
  readonly usn: string;
  readonly gid: string;
  readonly vrs?: Record<string, string>;
  readonly iat: number;
  readonly exp: number;
}

const HEADER = { alg: "HS256", typ: "JWT" } as const;
const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * 从主密钥派生某个租户的 HMAC 密钥（HKDF-SHA256，salt = 租户 id）。
 *
 * `purpose` 区分访问令牌与刷新令牌的签名密钥——上游用两个独立的配置项
 * （`encryption_key` / `refresh_encryption_key`）表达同一件事，效果是
 * 一个令牌不可能被拿去当另一个用。
 */
export async function deriveTenantSessionKey(
  masterSecret: string,
  tenantId: string,
  purpose: "session" | "refresh" = "session",
): Promise<CryptoKey> {
  const master = await crypto.subtle.importKey("raw", encoder.encode(masterSecret), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(tenantId),
      info: encoder.encode(`muster/${purpose}`),
    },
    master,
    256,
  );
  return crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function encodeSegment(value: unknown): string {
  return base64UrlEncode(encoder.encode(JSON.stringify(value)));
}

/** 签发。返回的 token 是 `header.payload.signature` 三段 base64url。 */
export async function signSessionToken(key: CryptoKey, claims: SessionClaims): Promise<string> {
  const payload = {
    tid: claims.tid,
    uid: claims.uid,
    usn: claims.usn,
    gid: claims.gid,
    ...(claims.vrs === undefined ? {} : { vrs: claims.vrs }),
    iat: claims.iat,
    exp: claims.exp,
  };
  const signingInput = `${encodeSegment(HEADER)}.${encodeSegment(payload)}`;
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export interface VerifyOptions {
  /** 当前时间（Unix 秒）。显式传入，便于测试注入。 */
  readonly nowSec: number;
}

/**
 * **不校验签名**地读出 `gid`（租户 id）。
 *
 * 这是多租户解析的必要一步：要校验一个令牌，先得知道用哪个租户的派生密钥；
 * 而"用哪个租户的密钥"这件事就写在令牌里。先读后用签名验，是安全的——
 * 攻击者把 gid 改成别的租户，只会导致用错误的密钥去验，校验必然失败。
 * 因此这个函数的返回值**只能**用来选密钥，不能当作任何身份事实。
 */
export function peekTenantId(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1] as string)));
    if (typeof payload !== "object" || payload === null) return null;
    const gid = (payload as { gid?: unknown }).gid;
    return typeof gid === "string" && gid !== "" ? gid : null;
  } catch {
    return null;
  }
}

/**
 * 校验并解析。任何一步不对都返回 `null`（调用方统一映射成上游的
 * `401 Auth token invalid`），不把"哪里不对"泄露给客户端。
 */
export async function verifySessionToken(
  key: CryptoKey,
  token: string,
  options: VerifyOptions,
): Promise<SessionClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlDecode(signature);
  } catch {
    return null;
  }

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    encoder.encode(`${header}.${payload}`),
  );
  if (!valid) return null;

  let decodedHeader: unknown;
  let decodedPayload: unknown;
  try {
    decodedHeader = JSON.parse(new TextDecoder().decode(base64UrlDecode(header)));
    decodedPayload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch {
    return null;
  }

  if (
    typeof decodedHeader !== "object" ||
    decodedHeader === null ||
    (decodedHeader as { alg?: unknown }).alg !== "HS256"
  ) {
    return null;
  }
  if (typeof decodedPayload !== "object" || decodedPayload === null) return null;

  const claims = decodedPayload as Partial<SessionClaims>;
  if (
    typeof claims.tid !== "string" ||
    typeof claims.uid !== "string" ||
    typeof claims.usn !== "string" ||
    typeof claims.gid !== "string" ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number"
  ) {
    return null;
  }
  if (claims.exp <= options.nowSec) return null;

  return {
    tid: claims.tid,
    uid: claims.uid,
    usn: claims.usn,
    gid: claims.gid,
    ...(claims.vrs === undefined ? {} : { vrs: claims.vrs }),
    iat: claims.iat,
    exp: claims.exp,
  };
}
