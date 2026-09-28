/**
 * M1 契约测试：本地 D1 底座 / 服务端密钥鉴权 / 上游对账
 *
 * 拆自原 `tests/integration/identity.test.ts`（文件太长，按主题分家）。
 * 共享常量与整份契约源清单见 `tests/helpers/identity-fixtures.ts`。
 * 测试只跑本地 workerd + 本地 D1，不碰任何 Cloudflare 远端资源。
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { DEVICE, errorBody } from "../../helpers/identity-fixtures";
import { basicAuth, call, createBothTenants } from "../../helpers/tenants";

beforeAll(async () => {
  await createBothTenants();
});

describe("M1 底座: 本地 D1", () => {
  it("test_identity_schema_is_applied_to_local_d1", async () => {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' " +
        "AND name IN ('tenants','users','user_identity','sessions')",
    ).first<{ count: number }>();
    expect(row?.count).toBe(4);
  });
});


describe("M1 契约: 服务端密钥鉴权", () => {
  it("test_authenticate_without_server_key_returns_401_unauthenticated", async () => {
    const res = await call("/v2/account/authenticate/device?create=true", { body: { id: DEVICE } });
    expect(res.status).toBe(401);
    expect(await errorBody(res)).toEqual({ code: 16, message: "Server key required" });
  });

  it("test_authenticate_with_wrong_server_key_returns_401_unauthenticated", async () => {
    const res = await call("/v2/account/authenticate/device?create=true", {
      authorization: basicAuth("not-the-key"),
      body: { id: DEVICE },
    });
    expect(res.status).toBe(401);
    expect(await errorBody(res)).toEqual({ code: 16, message: "Server key invalid" });
  });

  it("test_authenticate_with_bearer_header_instead_of_basic_returns_401_server_key_invalid", async () => {
    // 上游 parseBasicAuth 只认大小写敏感的 "Basic " 前缀：给 Bearer 只会被当成"头格式不对"。
    const res = await call("/v2/account/authenticate/device?create=true", {
      authorization: "Bearer whatever",
      body: { id: DEVICE },
    });
    expect(res.status).toBe(401);
    expect(await errorBody(res)).toEqual({ code: 16, message: "Server key invalid" });
  });

  it("test_401_responses_carry_bearer_challenge_header", async () => {
    // 溯源: server/api_test.go::TestWWWAuthenticateHeaderOnUnauthenticated
    // 上游断言两件事：401 必须带 Bearer 挑战头；头里不能塞 gRPC 的原始错误文案。
    // 唯一刻意不同：realm 用本项目的名字（ECN-0003），不复刻上游产品名。
    const res = await call("/v2/session/logout", { method: "POST", body: {} });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="muster"');
    expect(res.headers.get("www-authenticate")).not.toContain("Auth token required");
    expect((await errorBody(res)).message).toBe("Auth token required");
  });

  it("test_user_route_without_token_returns_401_auth_token_required", async () => {
    const res = await call("/v2/account", { method: "GET" });
    expect(res.status).toBe(401);
    expect(await errorBody(res)).toEqual({ code: 16, message: "Auth token required" });
  });

  it("test_bearer_route_ignores_server_key_and_still_requires_token", async () => {
    // 已认证端点**不**接受 server key：Basic 头在这里等于"不是 Bearer"，报 Auth token invalid。
    const res = await call("/v2/account", { method: "GET", authorization: basicAuth("test-server-key-aaaa") });
    expect(res.status).toBe(401);
    expect(await errorBody(res)).toEqual({ code: 16, message: "Auth token invalid" });
  });
});


describe("M1 契约: 上游对账（501/404）", () => {
  it("test_upstream_path_we_have_not_implemented_returns_501", async () => {
    // `POST /v2/iap/purchase/google` 在上游 REST 表里存在、本项目还没做 →
    // 诚实地说"有、没做"（而不是 404 假装不存在）。
    // 这条用例会随里程碑推进而"换靶子"：M5 把 `/v2/friend` 做掉、M6 把
    // `/v2/tournament/{id}/join` 做掉，靶子就换到还没进任何里程碑的 IAP 面上。
    // 选它的原因是它**不在**任何里程碑的测试文件范围里（上游没有 IAP 的测试文件），
    // 所以它不会因为某个里程碑落地而再次过期。
    //
    // 路径选得**不能是两段**：`/v2/storage/{collection}` 会把任何 `v2/<名字>` 抢走，
    // 于是两段路径得到的是 "Method Not Allowed" 而不是 "Not implemented."。
    const res = await call("/v2/iap/purchase/google", { method: "POST" });
    expect(res.status).toBe(501);
    expect(await errorBody(res)).toEqual({ code: 12, message: "Not implemented." });
  });

  it("test_wrong_method_on_known_path_returns_501_method_not_allowed", async () => {
    const res = await call("/v2/account/authenticate/device", {
      method: "GET",
      authorization: basicAuth("whatever"),
    });
    expect(res.status).toBe(501);
    expect(await errorBody(res)).toEqual({ code: 12, message: "Method Not Allowed" });
  });

  it("test_path_that_does_not_exist_upstream_still_returns_404", async () => {
    const res = await call("/v2/definitely-not-a-thing", { method: "GET" });
    expect(res.status).toBe(404);
    expect(await errorBody(res)).toEqual({ code: 5, message: "Not Found" });
  });
});
