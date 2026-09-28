/**
 * RS256 验签（WebCrypto）。
 *
 * 上游是 `jwt.Parse(idToken, keyfunc, jwt.WithExpirationRequired(),
 * jwt.WithValidMethods([]string{"RS256"}))`，并且**拿证书表里的每一个公钥都试一遍**
 * ——keyfunc 完全不看 header 里的 `kid`。这里照抄这条：逐证书试，
 * 任何一个通过就算通过。看起来"浪费"，但它正是上游的行为，
 * 而"按 kid 挑证书"在 kid 缺失或错配时会改变判决。
 *
 * 公钥从 JWKS 的 `n` / `e` 导入（`crypto.subtle.importKey("jwk", …)`），
 * 不做用途之外的假设：`key_ops` 与 `ext` 都显式给，
 * 免得某个运行时的默认值让导入随环境而变。
 *
 * 契约源（机器可读）：
 * 契约源: social/social.go::CheckGoogleToken
 */

import type { ParsedGoogleJwt } from "./jwt";

/** 一个可用的证书：`kid` 只用于日志，判决不看它（见文件头）。 */
export interface GoogleCert {
  readonly kid: string | null;
  readonly key: CryptoKey;
}

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** JWKS 的 `n` / `e` → 只可验签的公钥。 */
export async function importRsaPublicKey(modulus: string, exponent: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: modulus, e: exponent, alg: "RS256", ext: true },
    RS256,
    false,
    ["verify"],
  );
}

/**
 * 逐证书验签。
 *
 * 证书表为空时返回 false（而不是抛错）：上游在"一张证书都没有"时同样只是验不过。
 * 真正的取证书失败在 `certs.ts` 里就抛了，不会走到这里。
 */
export async function verifySignature(
  parsed: ParsedGoogleJwt,
  certs: readonly GoogleCert[],
): Promise<boolean> {
  const data = new TextEncoder().encode(parsed.signingInput);
  for (const cert of certs) {
    const ok = await crypto.subtle
      .verify("RSASSA-PKCS1-v1_5", cert.key, parsed.signature, data)
      .catch(() => false);
    if (ok) return true;
  }
  return false;
}
