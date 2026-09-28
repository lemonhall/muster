import { describe, expect, it } from "vitest";

import { createJwksCertSource, DEFAULT_CERT_TTL_SEC, type FetchLike } from "../../../src/domain/social/google/certs";
import { rsaPublicJwk } from "../../helpers/google-jwt";

/**
 * 证书表的取用与缓存（ECN-0009 的偏差 2 与那条注记）。
 *
 * 三条行为都是"能省一次外部请求就省一次"的直接后果，也都能在不联网的情况下判定：
 *   - TTL 内只取一次（TTL 来自 `Cache-Control: max-age`）；
 *   - 没给缓存指令就用兜底 TTL；
 *   - 刷新失败**抛错但不覆盖缓存**，下一次调用继续重试。
 */

const URL_UNDER_TEST = "https://certs.example.test/jwks";

/** 一份真实可用的 JWKS：公钥是本机生成的，私钥用完即弃（只用来满足 importKey）。 */
async function jwksBody(kid: string): Promise<{ keys: Record<string, string>[] }> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await rsaPublicJwk(pair.publicKey);
  return { keys: [{ kty: "RSA", kid, n: jwk.n, e: jwk.e }] };
}

interface Stub {
  readonly fetch: FetchLike;
  readonly calls: number[];
  next(result: { readonly status?: number; readonly cacheControl?: string; readonly body: unknown }): void;
}

function stub(): Stub {
  const calls: number[] = [];
  let current: { readonly status?: number; readonly cacheControl?: string; readonly body: unknown } = {
    body: { keys: [] },
  };
  return {
    calls,
    next(result) {
      current = result;
    },
    fetch: async () => {
      calls.push(calls.length + 1);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (current.cacheControl !== undefined) headers["cache-control"] = current.cacheControl;
      return new Response(JSON.stringify(current.body), { status: current.status ?? 200, headers });
    },
  };
}

describe("M5 契约: Google 证书表的缓存", () => {
  it("test_certs_are_fetched_once_inside_the_cache_control_ttl", async () => {
    const http = stub();
    http.next({ body: await jwksBody("kid-1"), cacheControl: "public, max-age=600" });
    let now = 1_000;
    const source = createJwksCertSource({ fetch: http.fetch, url: URL_UNDER_TEST, nowSec: () => now });

    const first = await source.get();
    now += 599;
    const second = await source.get();
    expect(second).toBe(first);
    expect(http.calls).toHaveLength(1);

    // TTL 到点后必须重新取（`max-age=600` 在 1000+600 这一刻到期）。
    now += 1;
    await source.get();
    expect(http.calls).toHaveLength(2);
  });

  it("test_certs_fall_back_to_the_default_ttl_without_cache_control", async () => {
    const http = stub();
    http.next({ body: await jwksBody("kid-1") });
    let now = 0;
    const source = createJwksCertSource({ fetch: http.fetch, url: URL_UNDER_TEST, nowSec: () => now });

    await source.get();
    now += DEFAULT_CERT_TTL_SEC - 1;
    await source.get();
    expect(http.calls).toHaveLength(1);
    now += 1;
    await source.get();
    expect(http.calls).toHaveLength(2);
  });

  it("test_a_failed_refresh_throws_and_keeps_retrying", async () => {
    const http = stub();
    http.next({ body: await jwksBody("kid-1"), cacheControl: "max-age=1" });
    let now = 0;
    const source = createJwksCertSource({ fetch: http.fetch, url: URL_UNDER_TEST, nowSec: () => now });
    await source.get();

    // TTL 到期 → 刷新；这次远端 500 → 抛错（旧证书留在缓存里，下一次仍会重试）。
    now += 2;
    http.next({ status: 500, body: { error: "boom" } });
    await expect(source.get()).rejects.toThrow();
    expect(http.calls).toHaveLength(2);

    now += 1;
    http.next({ body: await jwksBody("kid-2"), cacheControl: "max-age=600" });
    const recovered = await source.get();
    expect(http.calls).toHaveLength(3);
    expect(recovered[0]?.kid).toBe("kid-2");
  });

  it("test_a_jwks_without_usable_keys_is_rejected", async () => {
    const http = stub();
    http.next({ body: { keys: [{ kty: "EC", kid: "not-rsa" }] } });
    const source = createJwksCertSource({ fetch: http.fetch, url: URL_UNDER_TEST, nowSec: () => 0 });
    await expect(source.get()).rejects.toThrow();
  });
});
