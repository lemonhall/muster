import { describe, expect, it } from "vitest";
import { checkGoogleToken } from "../../../src/domain/social/google/token";
import { countingFetch, noCertsSource } from "../../helpers/google-jwt";

/**
 * 搬运上游 `social/google_token_audience_test.go` 的两个独立用例：
 *
 *   - `TestCheckGoogleTokenPreservesAuthorizationCodeFlow`：非 JWT 形状的值
 *     （授权码）走"换 token → 取 Play Games 档案"两步，且**各发生一次**；
 *   - `TestCheckGoogleTokenDoesNotExchangeMalformedJWT`：三段式但畸形的值一概不外发。
 *
 * 第二个用例的分量在于它挡的是"把畸形 JWT 当授权码发给 Google"——既有无效外部请求，
 * 也可能泄露本不该外发的字节。判定方式是**外部请求计数 = 0**（父级 fetch 桩）。
 *
 * 溯源: social/google_token_audience_test.go::TestCheckGoogleTokenPreservesAuthorizationCodeFlow,TestCheckGoogleTokenDoesNotExchangeMalformedJWT
 */

const NOW_SEC = 1_800_000_000;
const TOKEN_ENDPOINT = "https://oauth.example.test/token";

describe("M5 契约: Google 授权码流程与畸形 JWT 闸门", () => {
  it("test_check_google_token_preserves_the_authorization_code_flow", async () => {
    const http = countingFetch({
      "oauth.example.test": () => ({
        body: { access_token: "synthetic-access-token", token_type: "Bearer", expires_in: 3600 },
      }),
      "www.googleapis.com": () => ({
        body: { playerId: "synthetic-player", displayName: "Synthetic Player" },
      }),
    });

    const profile = await checkGoogleToken({
      idToken: "synthetic-authorization-code",
      clientIds: ["play-games-client"],
      certs: noCertsSource(),
      nowSec: NOW_SEC,
      authCode: {
        clientId: "play-games-client",
        clientSecret: "synthetic-secret",
        tokenEndpoint: TOKEN_ENDPOINT,
        fetch: http.fetch,
      },
    });

    expect(profile.googleId).toBe("synthetic-player");
    expect(profile.name).toBe("Synthetic Player");
    expect(http.requests.map((request) => new URL(request.url).host)).toEqual([
      "oauth.example.test",
      "www.googleapis.com",
    ]);
    // 取 token 是 POST，取档案是 GET（上游 oauth2 库 + 一次 GET）。
    expect(http.requests[0]?.method).toBe("POST");
    expect(http.requests[1]?.method).toBe("GET");
  });

  it("test_check_google_token_does_not_exchange_a_malformed_jwt", async () => {
    const http = countingFetch({
      "oauth.example.test": () => ({ body: { access_token: "should-not-be-requested" } }),
      "www.googleapis.com": () => ({ body: { playerId: "should-not-be-requested" } }),
    });

    await expect(
      checkGoogleToken({
        idToken: "not.a.jwt",
        clientIds: ["target-client.apps.googleusercontent.com"],
        certs: noCertsSource(),
        nowSec: NOW_SEC,
        authCode: {
          clientId: "target-client.apps.googleusercontent.com",
          clientSecret: "synthetic-secret",
          tokenEndpoint: TOKEN_ENDPOINT,
          fetch: http.fetch,
        },
      }),
    ).rejects.toThrow();

    expect(http.requests).toHaveLength(0);
    // 证书表也不该被碰：`noCertsSource` 一被调用就抛错（这里没抛，说明至少没走联网分支）。
  });

  it("test_check_google_token_rejects_a_non_jwt_when_the_code_flow_is_unconfigured", async () => {
    // 运营者没配 secret/endpoint 时，授权码流程不存在，任何非 JWT 输入直接判无效。
    await expect(
      checkGoogleToken({
        idToken: "synthetic-authorization-code",
        clientIds: [],
        certs: noCertsSource(),
        nowSec: NOW_SEC,
      }),
    ).rejects.toThrow();
  });
});
