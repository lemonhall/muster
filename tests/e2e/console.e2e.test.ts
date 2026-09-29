import { describe, expect, it } from "vitest";

import { e2eTenant, e2eTenantB } from "./global-setup";
import {
  authenticateDevice,
  basic,
  call,
  expectStatus,
  freshDeviceId,
  userIdOf,
} from "./http-helpers";

/**
 * M9 管理面（DoD 6）的 **E2E 那一半**：四条端点在**真进程、真 HTTP** 上跑通。
 *
 * 集成测试已经在 workerd 池里证明过语义；这里要证明的是**这些语义经得起一次真实的
 * 序列化/反序列化、真实的鉴权头解析、真实的 D1 往返**。两者的差别不是"更严格"，
 * 而是"覆盖另一种失败模式"：池里直接调处理函数永远不会碰到代理层与 HTTP 编解码。
 *
 * 三条断言刻意不做"只看 200"：
 *   - 建用户之后必须能在**列表**里看到它（写与读走的是同一条链）；
 *   - 空 ACL 被拒之后列表长度**不变**（拒绝发生在写之前，而不是写完之后回滚）；
 *   - 用**另一个租户**的 server key 列用户，看不到我刚建的那个（多租户隔离）。
 *
 * 用户名每次运行都换（本地 D1 跨运行保留），否则第二次跑就会撞唯一约束。
 *
 * 契约源（机器可读）：
 * 契约源: console/console.proto::Console/AddUser
 * 契约源: console/console.proto::Console/ResetUserPassword
 * 契约源: console/console.proto::Console/ListUsers
 * 契约源: console/console.proto::Console/GetWalletLedger
 *
 * REQ-0001-021
 */

const CREATE_PATH = "/v2/console/user";

interface ConsoleUserView {
  readonly username: string;
  readonly email: string;
  readonly acl: Record<string, Record<string, boolean>>;
  readonly mfa_required: boolean;
}

interface ConsoleListBody {
  readonly users: readonly ConsoleUserView[];
}

/**
 * 每次运行一个新的用户名。
 *
 * 服务端有两道与用户名有关的硬约束（上游原样）：长度 3..20、若干字号规则。前缀因此
 * 必须短——`e2e-operator-<8位>` 是 21 个字符，会被上游那条规则以 `InvalidArgument` 拒掉。
 */
function freshUsername(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function createBody(username: string, acl: Record<string, Record<string, boolean>>): unknown {
  return { username, email: `${username}@example.invalid`, acl };
}

async function listUsers(serverKey: string): Promise<ConsoleListBody> {
  const response = await call("/v2/console/user", { authorization: basic(serverKey) });
  expect(response.status).toBe(200);
  return (await response.json()) as ConsoleListBody;
}

describe("M9 管理面 E2E: 控制台用户", () => {
  it("test_creates_a_console_user_over_real_http_and_lists_it_back", async () => {
    const username = freshUsername("op");
    const created = await call(CREATE_PATH, {
      authorization: basic(e2eTenant.serverKey),
      body: createBody(username, { ACCOUNT: { read: true, write: true } }),
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { user: ConsoleUserView; token: string };
    expect(body.user.username).toBe(username.toLowerCase());
    expect(body.user.email).toBe(`${username.toLowerCase()}@example.invalid`);
    // 一次性 code（上游这里是 token；本项目的交付物是 code，见 ECN-0014 偏差 1）。
    expect(typeof body.token).toBe("string");
    expect(body.token).not.toBe("");
    // `EmitUnpopulated`：零值字段也出现，且 30 个资源逐格是布尔。
    expect(body.user.mfa_required).toBe(false);
    expect(body.user.acl.ACCOUNT).toEqual({ read: true, write: true, delete: false });
    expect(Object.keys(body.user.acl).length).toBeGreaterThanOrEqual(30);

    const mine = await listUsers(e2eTenant.serverKey);
    expect(mine.users.map((user) => user.username)).toContain(username.toLowerCase());

    // 换一个租户的 server key 就看不到：多租户隔离在真 HTTP 上成立。
    const theirs = await listUsers(e2eTenantB.serverKey);
    expect(theirs.users.map((user) => user.username)).not.toContain(username.toLowerCase());
  });

  it("test_an_empty_acl_is_rejected_before_anything_is_written", async () => {
    const before = (await listUsers(e2eTenant.serverKey)).users.length;
    const username = freshUsername("empty");

    const response = await call(CREATE_PATH, {
      authorization: basic(e2eTenant.serverKey),
      body: createBody(username, {}),
    });
    await expectStatus(response, 400, 3, "User must have at least some permissions.");

    // 反作弊：拒绝之后列表长度不变（不是"写进去了再回滚"）。
    const after = (await listUsers(e2eTenant.serverKey)).users;
    expect(after.length).toBe(before);
    expect(after.map((user) => user.username)).not.toContain(username.toLowerCase());
  });

  it("test_requires_a_server_key", async () => {
    const anonymous = await call(CREATE_PATH, { method: "POST", body: { username: "x", acl: {} } });
    // 上游这条路只认 Basic server key；没有凭据 → 401（Auth token invalid 一类），
    // 总之不是"200 然后静默成功"。
    expect(anonymous.status).toBe(401);
  });
});

describe("M9 管理面 E2E: 口令重置与钱包账本", () => {
  it("test_reset_issues_a_one_time_code_and_missing_users_are_not_found", async () => {
    const username = freshUsername("rst");
    const created = await call(CREATE_PATH, {
      authorization: basic(e2eTenant.serverKey),
      body: createBody(username, { ACCOUNT: { read: true } }),
    });
    expect(created.status).toBe(200);

    const reset = await call(`/v2/console/user/${username.toLowerCase()}/reset/password`, {
      method: "POST",
      authorization: basic(e2eTenant.serverKey),
    });
    expect(reset.status).toBe(200);
    expect(((await reset.json()) as { code: string }).code).not.toBe("");

    const ghost = await call(`/v2/console/user/${freshUsername("ghost")}/reset/password`, {
      method: "POST",
      authorization: basic(e2eTenant.serverKey),
    });
    await expectStatus(ghost, 404, 5, "User not found.");
  });

  it("test_wallet_ledger_over_real_http_validates_then_returns_an_empty_page", async () => {
    const { session } = await authenticateDevice(e2eTenant, freshDeviceId());
    const userId = await userIdOf(session.token);

    const empty = await call(`/v2/console/account/${userId}/wallet-ledger?limit=5`, {
      authorization: basic(e2eTenant.serverKey),
    });
    expect(empty.status).toBe(200);
    // `EmitUnpopulated`：空列表与空游标都要出现，前端表格才不会整列消失。
    expect(await empty.json()).toEqual({ items: [], next_cursor: "", prev_cursor: "" });

    // 两条各自独立的校验：id 不合法、limit 缺失。
    const badId = await call("/v2/console/account/not-a-uuid/wallet-ledger?limit=5", {
      authorization: basic(e2eTenant.serverKey),
    });
    await expectStatus(badId, 400, 3, "Requires a valid user ID.");

    const noLimit = await call(`/v2/console/account/${userId}/wallet-ledger`, {
      authorization: basic(e2eTenant.serverKey),
    });
    await expectStatus(noLimit, 400, 3, "expects a limit value between 1 and 100");
  });
});
