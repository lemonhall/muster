import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
  TENANT_A_REF,
  TENANT_B_REF,
  authenticateDeviceOrFail,
  basicAuth,
  bearer,
  call,
  createBothTenants,
  createTenant,
  findUserByIdentity,
} from "../helpers/tenants";

/**
 * M1 契约：多租户隔离（REQ-0001-026 / ECN-0001）。
 *
 * 要证明的不是"我们写了 tenant_id 这个列"，而是三件**可观测**的事：
 *   1. 同一个 device / username / email 在两个租户下是**两套**账号，互不覆盖；
 *   2. 一个租户的令牌拿不到另一个租户的数据（密码学层就过不去）；
 *   3. 没有 server key 就进不来，未知或已禁用的 server key 一律 401。
 *
 * 契约源（机器可读）：
 * 契约源: server/api.go::securityInterceptorFunc
 * 契约源: server/api_authenticate.go::AuthenticateDevice
 *
 * REQ-0001-026
 */

beforeAll(async () => {
  await createBothTenants();
});

async function errorBody(response: Response): Promise<{ code: number; message: string }> {
  return (await response.json()) as { code: number; message: string };
}

describe("M1 契约: 一个部署运营多个游戏", () => {
  it("test_same_device_id_creates_two_independent_accounts", async () => {
    const device = "shared-device-0001";
    const sessionA = await authenticateDeviceOrFail(TENANT_A_REF, device);
    const sessionB = await authenticateDeviceOrFail(TENANT_B_REF, device);

    const userA = await findUserByIdentity(TENANT_A_REF.id, "device", device);
    const userB = await findUserByIdentity(TENANT_B_REF.id, "device", device);
    expect(userA).not.toBeNull();
    expect(userB).not.toBeNull();
    expect(userA?.id).not.toBe(userB?.id);

    // 两个令牌各自能读到**自己**那个账号。
    const accountA = (await (
      await call("/v2/account", { method: "GET", authorization: bearer(sessionA.token) })
    ).json()) as { user: { id: string } };
    const accountB = (await (
      await call("/v2/account", { method: "GET", authorization: bearer(sessionB.token) })
    ).json()) as { user: { id: string } };
    expect(accountA.user.id).toBe(userA?.id);
    expect(accountB.user.id).toBe(userB?.id);
  });

  it("test_same_username_can_exist_in_both_tenants", async () => {
    const shared = "same-name-user";
    const first = await call(`/v2/account/authenticate/device?create=true&username=${shared}`, {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { id: "username-clash-0001" },
    });
    const second = await call(`/v2/account/authenticate/device?create=true&username=${shared}`, {
      authorization: basicAuth(TENANT_B_REF.serverKey),
      body: { id: "username-clash-0001" },
    });
    // 上游是"整库唯一"，我们是"租户内唯一"——同一个名字在两个游戏里各有一个账号。
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(((await first.json()) as { created?: boolean }).created).toBe(true);
    expect(((await second.json()) as { created?: boolean }).created).toBe(true);

    const userA = await findUserByIdentity(TENANT_A_REF.id, "device", "username-clash-0001");
    const userB = await findUserByIdentity(TENANT_B_REF.id, "device", "username-clash-0001");
    expect(userA?.username).toBe(shared);
    expect(userB?.username).toBe(shared);
    expect(userA?.id).not.toBe(userB?.id);
  });

  it("test_user_lookup_never_crosses_tenants", async () => {
    const sessionB = await authenticateDeviceOrFail(TENANT_B_REF, "lookup-device-0002");
    const userA = await findUserByIdentity(TENANT_A_REF.id, "device", "username-clash-0001");

    const byUsername = await call(`/v2/user?usernames=${userA?.username}`, {
      method: "GET",
      authorization: bearer(sessionB.token),
    });
    expect(byUsername.status).toBe(200);
    const body = (await byUsername.json()) as { users: { id: string }[] };
    // B 租户看到的是 B 自己那个同名账号，不可能是 A 的。
    expect(body.users).toHaveLength(1);
    expect(body.users[0]?.id).not.toBe(userA?.id);

    const byId = await call(`/v2/user?ids=${userA?.id}`, {
      method: "GET",
      authorization: bearer(sessionB.token),
    });
    expect(byId.status).toBe(200);
    // A 的 user id 在 B 租户里查不到 → 上游形状是 `{}`（空 repeated 字段被省略）。
    expect(await byId.json()).toEqual({});
  });

  it("test_refresh_token_from_one_tenant_is_rejected_by_another_tenants_server_key", async () => {
    const sessionA = await authenticateDeviceOrFail(TENANT_A_REF, "cross-tenant-0003");
    const res = await call("/v2/account/session/refresh", {
      authorization: basicAuth(TENANT_B_REF.serverKey),
      body: { token: sessionA.refresh_token },
    });
    expect(res.status).toBe(401);
    expect(await errorBody(res)).toEqual({ code: 16, message: "Refresh token invalid or expired." });
  });

  it("test_sessions_are_filed_under_the_tenant_that_created_them", async () => {
    const countFor = async (tenantId: string): Promise<number> => {
      const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions WHERE tenant_id = ?1")
        .bind(tenantId)
        .first<{ count: number }>();
      return row?.count ?? 0;
    };

    const beforeB = await countFor(TENANT_B_REF.id);
    await authenticateDeviceOrFail(TENANT_A_REF, "isolation-row-0004");
    // A 的登录不该在 B 的会话表里留下任何东西。
    expect(await countFor(TENANT_B_REF.id)).toBe(beforeB);
    expect(await countFor(TENANT_A_REF.id)).toBeGreaterThan(0);
  });

  it("test_disabled_tenant_cannot_authenticate", async () => {
    const disabledId = "CCCCCCCC-0000-4000-8000-000000000003";
    const disabledKey = "test-server-key-cccc";
    await createTenant(disabledId, disabledKey, "tenant-disabled");
    await env.DB.prepare("UPDATE tenants SET disable_time = ?1 WHERE id = ?2")
      .bind(Math.floor(Date.now() / 1000), disabledId)
      .run();

    const res = await call("/v2/account/authenticate/device?create=true", {
      authorization: basicAuth(disabledKey),
      body: { id: "device-disabled-01" },
    });
    expect(res.status).toBe(401);
    expect(await errorBody(res)).toEqual({ code: 16, message: "Server key invalid" });
  });

  it("test_unknown_server_key_is_not_a_tenant", async () => {
    const res = await call("/v2/account/authenticate/device?create=true", {
      authorization: basicAuth("some-key-that-was-never-issued"),
      body: { id: "device-unknown-01" },
    });
    expect(res.status).toBe(401);
    expect(await errorBody(res)).toEqual({ code: 16, message: "Server key invalid" });
  });
});
