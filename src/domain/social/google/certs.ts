/**
 * Google 公钥证书的取用与缓存（JWKS）。
 *
 * 上游从 `https://www.googleapis.com/oauth2/v1/certs` 取一张 `kid → PEM(X.509)` 表，
 * 用 `x509.ParseCertificate` 解出 RSA 公钥，缓存到"最早到期证书的 NotAfter 前 1 小时"。
 * 本项目改用 `https://www.googleapis.com/oauth2/v3/certs`（JWKS）：同一套密钥的另一种视图，
 * 直接给 `n` / `e`，WebCrypto 一步导入。理由与代价写在
 * [ECN-0009](../../../../docs/ecn/ECN-0009-google-id-token.md)（偏差 1/2）。
 *
 * 缓存的语义照抄上游的两条：
 *   1. **刷新失败不清空旧证书**——上一份继续可用，下一次调用再试；
 *   2. TTL 到了才刷新，且在途请求合并成一次（上游用互斥锁做同一件事）。
 *
 * 契约源（机器可读）：
 * 契约源: social/social.go::CheckGoogleToken
 */

import { GoogleTokenError } from "./jwt";
import { importRsaPublicKey, type GoogleCert } from "./verify";

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

/** JWKS 没给可用 TTL 时的兜底：1 小时。 */
export const DEFAULT_CERT_TTL_SEC = 3600;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 一张证书表。实现可以缓存，调用方只看到"给我现在能用的公钥"。 */
export interface GoogleCertSource {
  get(): Promise<readonly GoogleCert[]>;
}

export interface CertSourceOptions {
  readonly fetch: FetchLike;
  readonly url?: string;
  readonly nowSec?: () => number;
}

export function createJwksCertSource(options: CertSourceOptions): GoogleCertSource {
  const url = options.url ?? GOOGLE_JWKS_URL;
  const nowSec = options.nowSec ?? (() => Math.floor(Date.now() / 1000));
  let cache: { readonly certs: readonly GoogleCert[]; readonly expiresAt: number } | null = null;
  let inFlight: Promise<readonly GoogleCert[]> | null = null;

  return {
    async get(): Promise<readonly GoogleCert[]> {
      const now = nowSec();
      if (cache !== null && cache.expiresAt > now) return cache.certs;
      if (inFlight !== null) return inFlight;

      const load = (async () => {
        try {
          const response = await options.fetch(url, { headers: { accept: "application/json" } });
          if (!response.ok) {
            throw new GoogleTokenError(`google certs endpoint returned ${response.status}`);
          }
          const certs = await jwksToCerts(await response.json());
          cache = { certs, expiresAt: now + ttlSecOf(response) };
          return certs;
        } finally {
          inFlight = null;
        }
      })();
      inFlight = load;
      return load;
    },
  };
}

/** JWKS → 公钥表。非 RSA 的条目直接跳过（Google 的密钥集里没有别的类型，跳过比报错稳）。 */
export async function jwksToCerts(body: unknown): Promise<readonly GoogleCert[]> {
  const keys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) throw new GoogleTokenError("google certs response has no keys array");

  const certs: GoogleCert[] = [];
  for (const entry of keys) {
    const jwk = entry as { kty?: unknown; n?: unknown; e?: unknown; kid?: unknown };
    if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") continue;
    certs.push({
      kid: typeof jwk.kid === "string" ? jwk.kid : null,
      key: await importRsaPublicKey(jwk.n, jwk.e),
    });
  }
  if (certs.length === 0) throw new GoogleTokenError("google certs response contained no usable RSA key");
  return certs;
}

/**
 * `Cache-Control: max-age=N` → TTL 秒；拿不到就用兜底值。
 *
 * 与上游的差别在这里被收窄：上游按证书自身的 `NotAfter` 定刷新时刻，JWKS 没有有效期字段，
 * 只能信 Google 回给我们的缓存指令（ECN-0009 偏差 2）。
 */
function ttlSecOf(response: Response): number {
  const header = response.headers.get("cache-control") ?? "";
  const match = /max-age=(\d+)/i.exec(header);
  if (match === null) return DEFAULT_CERT_TTL_SEC;
  const seconds = Number(match[1]);
  return Number.isInteger(seconds) && seconds > 0 ? seconds : DEFAULT_CERT_TTL_SEC;
}
