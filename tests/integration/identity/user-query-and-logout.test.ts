/**
 * M1 契约测试：用户查询与登出
 *
 * 拆自原 `tests/integration/identity.test.ts`（文件太长，按主题分家）。
 * 共享常量与整份契约源清单见 `tests/helpers/identity-fixtures.ts`。
 * 测试只跑本地 workerd + 本地 D1，不碰任何 Cloudflare 远端资源。
 */

import { beforeAll, describe, expect, it } from "vitest";

import { errorBody } from "../../helpers/identity-fixtures";
import { TENANT_A_REF, authenticateDeviceOrFail, bearer, call, createBothTenants } from "../../helpers/tenants";

beforeAll(async () => {
  await createBothTenants();
});

describe("M1 契约: 用户查询", () => {
  it("test_get_users_by_id_and_username", async () => {
    const session = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000040");
    const account = (await (
      await call("/v2/account", { method: "GET", authorization: bearer(session.token) })
    ).json()) as { user: { id: string; username: string } };

    const byId = await call(`/v2/user?ids=${account.user.id}`, {
      method: "GET",
      authorization: bearer(session.token),
    });
    expect(byId.status).toBe(200);
    expect(((await byId.json()) as { users: unknown[] }).users).toHaveLength(1);

    const byUsername = await call(`/v2/user?usernames=${account.user.username}`, {
      method: "GET",
      authorization: bearer(session.token),
    });
    expect(((await byUsername.json()) as { users: { id: string }[] }).users[0]?.id).toBe(account.user.id);
  });

  it("test_get_users_with_no_query_returns_empty_object", async () => {
    const session = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000041");
    const res = await call("/v2/user", { method: "GET", authorization: bearer(session.token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("test_get_users_rejects_malformed_id", async () => {
    const session = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000042");
    const res = await call("/v2/user?ids=not-a-uuid", {
      method: "GET",
      authorization: bearer(session.token),
    });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ code: 3, message: "ID 'not-a-uuid' is not a valid system ID." });
  });

  it("test_get_users_accepts_repeated_query_parameters", async () => {
    const first = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000043");
    const second = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000044");
    const readId = async (token: string): Promise<string> =>
      ((await (await call("/v2/account", { method: "GET", authorization: bearer(token) })).json()) as {
        user: { id: string };
      }).user.id;
    const ids = [await readId(first.token), await readId(second.token)];
    const res = await call(`/v2/user?ids=${ids[0]}&ids=${ids[1]}`, {
      method: "GET",
      authorization: bearer(first.token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { id: string }[] };
    expect(body.users.map((user) => user.id).sort()).toEqual([...ids].sort());
  });
});


describe("M1 契约: 登出", () => {
  it("test_logout_with_access_token_invalidates_it", async () => {
    const session = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000050");
    const res = await call("/v2/session/logout", {
      method: "POST",
      authorization: bearer(session.token),
      body: { token: session.token },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});

    const after = await call("/v2/account", { method: "GET", authorization: bearer(session.token) });
    expect(after.status).toBe(401);
    expect(await errorBody(after)).toEqual({ code: 16, message: "Auth token invalid" });
  });

  it("test_logout_with_refresh_token_invalidates_the_session", async () => {
    const session = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000054");
    const res = await call("/v2/session/logout", {
      method: "POST",
      authorization: bearer(session.token),
      body: { refresh_token: session.refresh_token },
    });
    expect(res.status).toBe(200);

    // 吊销是按 token_id 的，所以 access token 也随之失效。
    const after = await call("/v2/account", { method: "GET", authorization: bearer(session.token) });
    expect(after.status).toBe(401);
  });

  it("test_logout_with_empty_body_revokes_all_sessions", async () => {
    const session = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000051");
    const second = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000051");
    const res = await call("/v2/session/logout", {
      method: "POST",
      authorization: bearer(session.token),
      body: {},
    });
    expect(res.status).toBe(200);

    for (const token of [session.token, second.token]) {
      const after = await call("/v2/account", { method: "GET", authorization: bearer(token) });
      expect(after.status).toBe(401);
    }
  });

  it("test_logout_with_someone_elses_token_returns_400", async () => {
    const mine = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000052");
    const other = await authenticateDeviceOrFail(TENANT_A_REF, "device-id-000053");
    const res = await call("/v2/session/logout", {
      method: "POST",
      authorization: bearer(mine.token),
      body: { token: other.token },
    });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ code: 3, message: "Session token invalid." });
  });
});
