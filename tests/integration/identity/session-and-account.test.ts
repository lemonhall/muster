/**
 * M1 契约测试：令牌与会话 / 账号资料
 *
 * 拆自原 `tests/integration/identity.test.ts`（文件太长，按主题分家）。
 * 共享常量与整份契约源清单见 `tests/helpers/identity-fixtures.ts`。
 * 测试只跑本地 workerd + 本地 D1，不碰任何 Cloudflare 远端资源。
 */

import { beforeAll, describe, expect, it } from "vitest";

import { deriveTenantSessionKey, signSessionToken } from "../../../src/domain/identity/token";
import { errorBody } from "../../helpers/identity-fixtures";
import { type SessionBody, TENANT_A_REF, TEST_MASTER_SECRET, authenticateDeviceOrFail, basicAuth, bearer, call, createBothTenants } from "../../helpers/tenants";

beforeAll(async () => {
  await createBothTenants();
});

describe("M1 契约: 令牌与会话", () => {
  it("test_refresh_token_issues_a_working_access_token", async () => {
    const session = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000020");
    const res = await call("/v2/account/session/refresh", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { token: session.refresh_token },
    });
    expect(res.status).toBe(200);
    const refreshed = (await res.json()) as SessionBody;
    expect("created" in refreshed).toBe(false);

    const account = await call("/v2/account", { method: "GET", authorization: bearer(refreshed.token) });
    expect(account.status).toBe(200);
  });

  it("test_refresh_with_access_token_returns_401", async () => {
    const session = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000021");
    const res = await call("/v2/account/session/refresh", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { token: session.token },
    });
    expect(res.status).toBe(401);
    expect(await errorBody(res)).toEqual({ code: 16, message: "Refresh token invalid or expired." });
  });

  it("test_refresh_requires_a_token", async () => {
    const res = await call("/v2/account/session/refresh", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: {},
    });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ code: 3, message: "Refresh token is required." });
  });

  it("test_token_signed_with_another_key_is_rejected", async () => {
    const forged = await signSessionToken(
      await deriveTenantSessionKey("some-other-master-secret", TENANT_A_REF.id, "session"),
      {
        tid: crypto.randomUUID().toUpperCase(),
        uid: "00000000-0000-4000-8000-000000000000",
        usn: "forged",
        gid: TENANT_A_REF.id,
        iat: 0,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    );
    const res = await call("/v2/account", { method: "GET", authorization: bearer(forged) });
    expect(res.status).toBe(401);
    expect(await errorBody(res)).toEqual({ code: 16, message: "Auth token invalid" });
  });

  it("test_expired_token_is_rejected", async () => {
    const key = await deriveTenantSessionKey(TEST_MASTER_SECRET, TENANT_A_REF.id, "session");
    const expired = await signSessionToken(key, {
      tid: crypto.randomUUID().toUpperCase(),
      uid: "00000000-0000-4000-8000-000000000000",
      usn: "expired",
      gid: TENANT_A_REF.id,
      iat: 1,
      exp: 2,
    });
    const res = await call("/v2/account", { method: "GET", authorization: bearer(expired) });
    expect(res.status).toBe(401);
    expect(await errorBody(res)).toEqual({ code: 16, message: "Auth token invalid" });
  });

  it("test_malformed_bearer_token_is_rejected", async () => {
    const res = await call("/v2/account", { method: "GET", authorization: "Bearer not.a.jwt" });
    expect(res.status).toBe(401);
    expect(await errorBody(res)).toEqual({ code: 16, message: "Auth token invalid" });
  });

  it("test_token_without_tenant_claim_is_rejected", async () => {
    // 没有 gid 的令牌无法定位租户 → 与"令牌无效"同形，不泄露任何登记信息。
    const key = await deriveTenantSessionKey(TEST_MASTER_SECRET, TENANT_A_REF.id, "session");
    const noTenant = await signSessionToken(key, {
      tid: crypto.randomUUID().toUpperCase(),
      uid: "00000000-0000-4000-8000-000000000000",
      usn: "no-tenant",
      gid: "",
      iat: 0,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const res = await call("/v2/account", { method: "GET", authorization: bearer(noTenant) });
    expect(res.status).toBe(401);
    expect(await errorBody(res)).toEqual({ code: 16, message: "Auth token invalid" });
  });
});


describe("M1 契约: 账号资料", () => {
  it("test_get_account_returns_user_wallet_and_devices", async () => {
    const session = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000030");
    const res = await call("/v2/account", { method: "GET", authorization: bearer(session.token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.wallet).toBe("{}");
    expect(body.devices).toEqual([{ id: "device-id-000030" }]);
    const user = body.user as Record<string, unknown>;
    expect(typeof user.id).toBe("string");
    expect(typeof user.username).toBe("string");
    // 零值字段整条省略（protojson 默认不带 EmitUnpopulated）。
    expect("display_name" in user).toBe(false);
    // disable_time 在用户可见的 account 面上被上游显式清掉。
    expect("disable_time" in body).toBe(false);
  });

  it("test_update_account_changes_only_provided_fields", async () => {
    const session = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000031");
    const readAccount = async (): Promise<{ user: Record<string, unknown> }> =>
      (await (await call("/v2/account", { method: "GET", authorization: bearer(session.token) })).json()) as {
        user: Record<string, unknown>;
      };
    const before = await readAccount();

    const updated = await call("/v2/account", {
      method: "PUT",
      authorization: bearer(session.token),
      body: { display_name: "柠檬叔", lang_tag: "zh-Hans" },
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({});

    const after = await readAccount();
    expect(after.user.display_name).toBe("柠檬叔");
    expect(after.user.lang_tag).toBe("zh-Hans");
    // 没出现在 body 里的字段保持原值。
    expect(after.user.username).toBe(before.user.username);
    expect(after.user.avatar_url).toBeUndefined();
  });

  it("test_update_account_accepts_camel_case_field_names", async () => {
    // 官方 SDK 发的是 lowerCamelCase；protojson 的输入两种都认，我们也要两种都认。
    const session = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000032");
    const res = await call("/v2/account", {
      method: "PUT",
      authorization: bearer(session.token),
      body: { avatarUrl: "https://example.com/a.png" },
    });
    expect(res.status).toBe(200);
    const account = (await (
      await call("/v2/account", { method: "GET", authorization: bearer(session.token) })
    ).json()) as { user: Record<string, unknown> };
    expect(account.user.avatar_url).toBe("https://example.com/a.png");
  });

  it("test_update_account_with_no_fields_returns_400", async () => {
    const session = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000033");
    const res = await call("/v2/account", {
      method: "PUT",
      authorization: bearer(session.token),
      body: {},
    });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ code: 3, message: "No fields to update." });
  });

  it("test_update_account_to_taken_username_returns_409", async () => {
    const first = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000034");
    const second = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000035");
    await call("/v2/account", {
      method: "PUT",
      authorization: bearer(first.token),
      body: { username: "occupied-name" },
    });
    const res = await call("/v2/account", {
      method: "PUT",
      authorization: bearer(second.token),
      body: { username: "occupied-name" },
    });
    expect(res.status).toBe(409);
    expect(await errorBody(res)).toEqual({ code: 6, message: "Username is already in use." });
  });

  it("test_update_account_rejects_empty_username", async () => {
    const session = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000036");
    const res = await call("/v2/account", {
      method: "PUT",
      authorization: bearer(session.token),
      body: { username: "" },
    });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ code: 3, message: "Username invalid, must be 1-128 bytes." });
  });
});

