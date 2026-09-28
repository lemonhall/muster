import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { socialWorld } from "../../helpers/social-world";
import { basicAuth, call } from "../../helpers/tenants";
import { ACL_RESOURCES } from "../../../src/domain/console/acl/resources";

/**
 * M9 集成测试：控制台用户面的三条端点（DoD 6 的前半）。
 *
 * 与单元测试的分工：单元测试证明"拒绝发生在副作用之前"（计数），这里证明
 * **整条 HTTP 链路**都按上游形状说话——状态码、文案、以及落库的行。
 *
 * 鉴权用 tenant server key（ECN-0014 偏差 1），所以每个请求都带 Basic。
 *
 * 契约源（机器可读）：
 * 契约源: server/console_user.go::AddUser
 * 契约源: server/console_user.go::ResetUserPassword
 * 契约源: server/console_user.go::ListUsers
 *
 * REQ-0001-021
 */

const CREATE_PATH = "/v2/console/user";

async function consoleUserCount(tenantId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM console_user WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .first<{ total: number }>();
  return row?.total ?? -1;
}

async function auditCount(tenantId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM console_audit WHERE tenant_id = ?1",
  )
    .bind(tenantId)
    .first<{ total: number }>();
  return row?.total ?? -1;
}

function createBody(username: string, acl: Record<string, Record<string, boolean>>): unknown {
  return { username, email: `${username}@example.invalid`, acl };
}

describe("M9 控制台用户: 建用户", () => {
  it("test_creates_a_user_with_a_full_acl_and_one_audit_row", async () => {
    const world = await socialWorld(1);
    const response = await call(CREATE_PATH, {
      authorization: basicAuth(world.serverKey),
      body: createBody("Operator", { ACCOUNT: { read: true, write: true } }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: Record<string, unknown>;
      token: string;
    };
    expect(body.user.username).toBe("operator");
    expect(body.user.email).toBe("operator@example.invalid");
    // `EmitUnpopulated`：零值字段也要出现（与客户端 API 相反，见 src/wire/console.ts）。
    expect(body.user.mfa_required).toBe(false);
    expect(body.user.mfa_enabled).toBe(false);
    // 30 个资源一个不少，且逐格是布尔（不是"只出现授予的格"）。
    const acl = body.user.acl as Record<string, Record<string, boolean>>;
    expect(Object.keys(acl)).toHaveLength(ACL_RESOURCES.length);
    expect(acl.ACCOUNT).toEqual({ read: true, write: true, delete: false });
    expect(acl.NOTIFICATION).toEqual({ read: false, write: false, delete: false });
    expect(body.token).not.toBe("");

    expect(await consoleUserCount(world.tenant)).toBe(1);
    expect(await auditCount(world.tenant)).toBe(1);
    // 一次性 code 存的是哈希，不是明文。
    const row = await env.DB.prepare(
      "SELECT password_code, password FROM console_user WHERE tenant_id = ?1 AND username = ?2",
    )
      .bind(world.tenant, "operator")
      .first<{ password_code: string; password: string }>();
    expect(row?.password_code).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.password_code).not.toBe(body.token);
    // 邀请阶段不设口令（上游同样留空，等一次性 code 换口令）。
    expect(row?.password).toBe("");
  });

  it("test_rejects_an_empty_acl_before_writing_anything", async () => {
    const world = await socialWorld(1);
    const response = await call(CREATE_PATH, {
      authorization: basicAuth(world.serverKey),
      body: createBody("nobody", {}),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: 3,
      message: "User must have at least some permissions.",
    });
    // 反作弊：状态码对不代表没写库。
    expect(await consoleUserCount(world.tenant)).toBe(0);
    expect(await auditCount(world.tenant)).toBe(0);
  });

  it("test_a_full_acl_is_accepted_because_the_server_key_is_the_tenant_root", async () => {
    const world = await socialWorld(1);
    const acl: Record<string, Record<string, boolean>> = {};
    for (const resource of ACL_RESOURCES) acl[resource] = { read: true, write: true, delete: true };
    const response = await call(CREATE_PATH, {
      authorization: basicAuth(world.serverKey),
      body: createBody("toolarge", acl),
    });
    // 管理面调用者就是租户根（Admin），所以"全量 90 位"其实是自己的权限——
    // 这一条在上游是"把别人的权限发回去"，在这里恰好合法。真正被拒的是**空权限**。
    expect(response.status).toBe(200);
    expect(await consoleUserCount(world.tenant)).toBe(1);
  });

  it("test_requires_a_server_key", async () => {
    const response = await call(CREATE_PATH, { body: createBody("x", { ACCOUNT: { read: true } }) });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 16, message: "Server key required" });
  });
});

describe("M9 控制台用户: 重置口令与列表", () => {
  it("test_reset_issues_a_code_and_writes_the_hashed_password", async () => {
    const world = await socialWorld(1);
    await call(CREATE_PATH, {
      authorization: basicAuth(world.serverKey),
      body: createBody("target", { ACCOUNT: { read: true } }),
    });
    const response = await call("/v2/console/user/target/reset/password", {
      method: "POST",
      authorization: basicAuth(world.serverKey),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { code: string };
    expect(body.code).not.toBe("");
    const row = await env.DB.prepare(
      "SELECT password, password_code FROM console_user WHERE tenant_id = ?1 AND username = ?2",
    )
      .bind(world.tenant, "target")
      .first<{ password: string; password_code: string }>();
    expect(row?.password.startsWith("pbkdf2-sha256$")).toBe(true);
    expect(row?.password_code).toMatch(/^[0-9a-f]{64}$/);
    // 建 + 重置 = 两行审计。
    expect(await auditCount(world.tenant)).toBe(2);
  });

  it("test_reset_of_a_missing_user_is_not_found", async () => {
    const world = await socialWorld(1);
    const response = await call("/v2/console/user/ghost/reset/password", {
      method: "POST",
      authorization: basicAuth(world.serverKey),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 5, message: "User not found." });
  });

  it("test_the_plan_spelled_alias_also_resets", async () => {
    const world = await socialWorld(1);
    await call(CREATE_PATH, {
      authorization: basicAuth(world.serverKey),
      body: createBody("alias", { ACCOUNT: { read: true } }),
    });
    const response = await call("/v2/console/user/alias/password-reset", {
      method: "POST",
      authorization: basicAuth(world.serverKey),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { code: string }).code).not.toBe("");
  });

  it("test_list_is_scoped_to_the_tenant", async () => {
    const first = await socialWorld(1);
    const second = await socialWorld(1);
    await call(CREATE_PATH, {
      authorization: basicAuth(first.serverKey),
      body: createBody("mine", { ACCOUNT: { read: true } }),
    });

    const mineResponse = await call("/v2/console/user", {
      authorization: basicAuth(first.serverKey),
    });
    const mine = (await mineResponse.json()) as { users: readonly { username: string }[] };
    expect(mine.users.map((user) => user.username)).toEqual(["mine"]);

    const theirs = await call("/v2/console/user", {
      authorization: basicAuth(second.serverKey),
    });
    expect(((await theirs.json()) as { users: readonly unknown[] }).users).toEqual([]);
  });
});
