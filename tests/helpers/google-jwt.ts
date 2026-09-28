/**
 * Google 验签测试的工装：本机生成 RSA 密钥、自签 ID token、可计数的 fetch。
 *
 * 上游 `social/google_token_audience_test.go` 用的是同一个套路（`rsa.GenerateKey` +
 * `jwt.NewWithClaims(...).SignedString(key)` + 把公钥塞进 `client.googleCerts`），
 * 区别只是用 WebCrypto 而不是 Go 的 crypto 包。**全程不联网**：
 * 公钥直接从内存里的 JWK 导入，证书表是注入的。
 */

import type { FetchLike, GoogleCertSource } from "../../src/domain/social/google/certs";
import type { GoogleCert } from "../../src/domain/social/google/verify";

export interface SigningFixture {
  /** 已导成 WebCrypto 公钥、可注入被测代码的证书表。 */
  readonly certs: GoogleCertSource;
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

export async function signingFixture(): Promise<SigningFixture> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const jwk = await rsaPublicJwk(pair.publicKey);
  const cert: GoogleCert = {
    kid: null,
    key: await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    ),
  };

  return {
    certs: { get: async () => [cert] },
    async sign(claims, header) {
      const signingInput = `${base64UrlJson({ alg: "RS256", typ: "JWT", ...header })}.${base64UrlJson(claims)}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(signingInput),
      );
      return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
    },
  };
}

/** 一次调用都不该发生的证书源：任何取证书的尝试都是测试失败。 */
export function noCertsSource(): GoogleCertSource {
  return {
    get: async () => {
      throw new Error("测试不该去取证书：这条路径应当在取证书之前就结束");
    },
  };
}

export interface CountingFetch {
  readonly fetch: FetchLike;
  /** 逐条记录请求（顺序即发生顺序）。 */
  readonly requests: { readonly url: string; readonly method: string }[];
}

/** 按 URL 路由的 fetch 桩，把所有请求记下来。 */
export function countingFetch(
  routes: Readonly<Record<string, () => { readonly status?: number; readonly body: unknown }>>,
): CountingFetch {
  const requests: { url: string; method: string }[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      const method = init?.method ?? "GET";
      requests.push({ url: input, method });
      const host = new URL(input).host;
      const route = routes[host];
      if (route === undefined) throw new Error(`测试没有为这个地址准备响应：${input}`);
      const { status = 200, body } = route();
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

export function base64UrlJson(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** 公钥的 JWK 参数（`exportKey` 的返回类型里还含 ArrayBuffer，这里收窄到 RSA 需要的两项）。 */
export async function rsaPublicJwk(key: CryptoKey): Promise<{ readonly n: string; readonly e: string }> {
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as { readonly n?: string; readonly e?: string };
  return { n: jwk.n ?? "", e: jwk.e ?? "AQAB" };
}

/** JWS 的签名段/头部段都是二进制，必须按字节编码（见 `src/domain/base64url.ts` 的说明）。 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
