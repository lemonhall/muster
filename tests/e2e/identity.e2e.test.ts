import { describe, expect, it } from "vitest";
import { e2eTenant, e2eTenantB } from "./global-setup";

/**
 * M1 E2E：身份 / 会话 / 账号，走真实 HTTP 通道。
 *
 * 与 `tests/integration/identity.test.ts` 的分工是刻意的：
 * - 集成测试直接 import 处理器，断言的是**领域语义**（校验顺序、错误文案、边界）；
 * - 这里只碰网络，断言的是**端到端真的成立**：HTTP 头、状态码、序列化、D1 落库、
 *   以及多租户隔离在真实请求下依然成立。
 *
 * 目标是一个本地 `wrangler dev --local` 进程（见 `global-setup.ts`），
 * 不连接任何 Cloudflare 账号资源，因此不产生账单。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_authenticate.go::AuthenticateDevice
 * 契约源: server/api_session.go::SessionRefresh
 * 契约源: server/api_session.go::SessionLogout
 * 契约源: server/api_account.go::GetAccount
 * 契约源: server/api_account.go::UpdateAccount
 * 契约源: server/api_user.go::GetUsers
 * 契约源: server/api.go::securityInterceptorFunc
 *
 * REQ-0001-003, REQ-0001-004, REQ-0001-005, REQ-0001-026
 */
const baseUrl = process.env.MUSTER_E2E_TARGET ?? `http://127.0.0.1:${process.env.MUSTER_E2E_PORT ?? "8788"}`;

interface TenantRef {
  readonly id: string;
  readonly serverKey: string;
}

interface HttpCall {
  readonly method?: string;
  readonly authorization?: string;
  readonly body?: unknown;
}

function call(path: string, options: HttpCall = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.authorization !== undefined) headers["authorization"] = options.authorization;
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

/** `Authorization: Basic base64(<server_key>:)`，与官方 SDK 的写法一致。 */
function basic(serverKey: string): string {
  return `Basic ${Buffer.from(`${serverKey}:`, "utf8").toString("base64")}`;
}

interface SessionBody {
  readonly created?: boolean;
  readonly token: string;
  readonly refresh_token: string;
}

/** 每次运行都用新的设备 ID：本地 D1 是跨运行保留的，固定 ID 会让断言依赖"上一轮"。 */
function freshDeviceId(prefix = "e2e"): string {
  return `${prefix}-device-${crypto.randomUUID()}`;
}

async function authenticateDevice(
  tenant: TenantRef,
  deviceId: string,
  query = "?create=true",
): Promise<{ status: number; session: SessionBody }> {
  const res = await call(`/v2/account/authenticate/device${query}`, {
    authorization: basic(tenant.serverKey),
    body: { id: deviceId },
  });
  expect(res.status).toBe(200);
  return { status: res.status, session: (await res.json()) as SessionBody };
}

async function accountOf(token: string): Promise<Record<string, unknown>> {
  const res = await call("/v2/account", { authorization: `Bearer ${token}` });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function userIdOf(token: string): Promise<string> {
  const account = await accountOf(token);
  return (account.user as { id: string }).id;
}

/** 断言失败响应是上游形状的 google.rpc.Status，并返回解析后的 body。 */
async function expectStatus(
  response: Response,
  status: number,
  code: number,
  message: string,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(await response.json()).toEqual({ code, message });
}

describe("M1 E2E: 设备认证与账号（真实 HTTP）", () => {
  it("test_device_authenticate_over_real_http_creates_account", async () => {
    const deviceId = freshDeviceId();
    const { session } = await authenticateDevice(e2eTenant, deviceId);

    expect(typeof session.token).toBe("string");
    expect(typeof session.refresh_token).toBe("string");
    // 三个段 = JWS compact 序列化；不是为了断言算法，而是为了断言"回来的是我们签的令牌"。
    expect(session.token.split(".")).toHaveLength(3);
    expect(session.created).toBe(true);
  });

  it("test_device_authenticate_is_idempotent_for_the_same_device", async () => {
    const deviceId = freshDeviceId();
    const first = await authenticateDevice(e2eTenant, deviceId);
    const second = await authenticateDevice(e2eTenant, deviceId);

    expect(second.session.created).toBeUndefined();
    expect(await userIdOf(first.session.token)).toBe(await userIdOf(second.session.token));
  });

  it("test_device_authenticate_without_create_returns_404_for_unknown_device", async () => {
    const res = await call("/v2/account/authenticate/device?create=false", {
      authorization: basic(e2eTenant.serverKey),
      body: { id: freshDeviceId() },
    });
    await expectStatus(res, 404, 5, "User account not found.");
  });

  it("test_account_requires_authentication_over_real_http", async () => {
    const res = await call("/v2/account");
    // 401 上必须带 Bearer 挑战头，且头里不能夹带原始错误消息（上游同款约定）。
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="muster"');
    await expectStatus(res, 401, 16, "Auth token required");
  });

  it("test_missing_server_key_is_rejected_over_real_http", async () => {
    const res = await call("/v2/account/authenticate/device", { body: { id: freshDeviceId() } });
    await expectStatus(res, 401, 16, "Server key required");
  });

  it("test_wrong_server_key_is_rejected_over_real_http", async () => {
    const res = await call("/v2/account/authenticate/device", {
      authorization: basic("not-a-registered-server-key"),
      body: { id: freshDeviceId() },
    });
    await expectStatus(res, 401, 16, "Server key invalid");
  });

  it("test_profile_update_round_trips_through_the_database", async () => {
    const { session } = await authenticateDevice(e2eTenant, freshDeviceId());
    const displayName = `e2e-${crypto.randomUUID()}`;

    const updated = await call("/v2/account", {
      method: "PUT",
      authorization: `Bearer ${session.token}`,
      body: { display_name: displayName, lang_tag: "zh" },
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({});

    const account = await accountOf(session.token);
    const user = account.user as Record<string, unknown>;
    expect(user.display_name).toBe(displayName);
    // 只改了出现过的字段：没给的字段不能凭空长出来。
    expect(user.location).toBeUndefined();
  });

  it("test_refresh_token_issues_a_working_access_token_over_real_http", async () => {
    const { session } = await authenticateDevice(e2eTenant, freshDeviceId());
    const res = await call("/v2/account/session/refresh", {
      authorization: basic(e2eTenant.serverKey),
      body: { token: session.refresh_token },
    });
    expect(res.status).toBe(200);
    const refreshed = (await res.json()) as SessionBody;

    expect(await userIdOf(refreshed.token)).toBe(await userIdOf(session.token));
    // 刷新令牌本身不能当访问令牌用（两把派生密钥各管一头）。
    await expectStatus(
      await call("/v2/account", { authorization: `Bearer ${session.refresh_token}` }),
      401,
      16,
      "Auth token invalid",
    );
  });

  it("test_logout_invalidates_the_access_token_over_real_http", async () => {
    const { session } = await authenticateDevice(e2eTenant, freshDeviceId());
    const logout = await call("/v2/session/logout", {
      authorization: `Bearer ${session.token}`,
      body: { token: session.token },
    });
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({});

    await expectStatus(
      await call("/v2/account", { authorization: `Bearer ${session.token}` }),
      401,
      16,
      "Auth token invalid",
    );
  });

  it("test_users_query_returns_the_account_over_real_http", async () => {
    // 用户名在租户内唯一，所以每次运行都必须换一个，否则第二轮会撞上 409。
    const username = `query-${crypto.randomUUID().slice(0, 8)}`;
    const { session } = await authenticateDevice(
      e2eTenant,
      freshDeviceId(),
      `?create=true&username=${username}`,
    );
    const userId = await userIdOf(session.token);

    const res = await call(`/v2/user?ids=${userId}`, { authorization: `Bearer ${session.token}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { id: string; username: string }[] };
    expect(body.users.map((user) => user.id)).toEqual([userId]);
  });

  it("test_unimplemented_upstream_path_says_so_over_real_http", async () => {
    // M1 只覆盖身份域；存储域的端点必须诚实地说"还没实现"，而不是假装不存在。
    const implementedMethod = await call("/v2/storage", {
      method: "POST",
      authorization: basic(e2eTenant.serverKey),
      body: {},
    });
    await expectStatus(implementedMethod, 501, 12, "Not implemented.");

    // 上游该路径没有 GET；"方法不符"与"路径没实现"是两条不同的消息，都要照搬。
    const unimplementedMethod = await call("/v2/storage", {
      authorization: basic(e2eTenant.serverKey),
    });
    await expectStatus(unimplementedMethod, 501, 12, "Method Not Allowed");
  });
});

describe("M1 E2E: 多租户隔离（真实 HTTP）", () => {
  it("test_same_device_id_in_two_tenants_yields_two_distinct_accounts", async () => {
    const deviceId = freshDeviceId("shared");
    const a = await authenticateDevice(e2eTenant, deviceId);
    const b = await authenticateDevice(e2eTenantB, deviceId);

    expect(a.session.created).toBe(true);
    expect(b.session.created).toBe(true);
    const userA = await userIdOf(a.session.token);
    const userB = await userIdOf(b.session.token);
    expect(userA).not.toBe(userB);
  });

  it("test_tenant_token_cannot_read_another_tenants_user", async () => {
    const deviceId = freshDeviceId("cross");
    const a = await authenticateDevice(e2eTenant, deviceId);
    const b = await authenticateDevice(e2eTenantB, deviceId);
    const userA = await userIdOf(a.session.token);

    // B 的令牌查 A 的用户 id：查得到才是泄漏。这里必须是"查不到"，而且形状与上游一致（空对象）。
    const peerQuery = await call(`/v2/user?ids=${userA}`, {
      authorization: `Bearer ${b.session.token}`,
    });
    expect(peerQuery.status).toBe(200);
    expect(await peerQuery.json()).toEqual({});

    // A 的令牌查 A 的用户 id：这才是正主，必须有。
    const ownQuery = await call(`/v2/user?ids=${userA}`, {
      authorization: `Bearer ${a.session.token}`,
    });
    expect(ownQuery.status).toBe(200);
    const own = (await ownQuery.json()) as { users: { id: string }[] };
    expect(own.users.map((user) => user.id)).toEqual([userA]);
  });

  it("test_same_username_can_live_in_two_tenants", async () => {
    const username = `dupe-${crypto.randomUUID().slice(0, 8)}`;
    const a = await authenticateDevice(
      e2eTenant,
      freshDeviceId("u"),
      `?create=true&username=${username}`,
    );
    const b = await authenticateDevice(
      e2eTenantB,
      freshDeviceId("u"),
      `?create=true&username=${username}`,
    );

    const tokenA = a.session.token;
    const tokenB = b.session.token;
    const seen = new Set([await userIdOf(tokenA), await userIdOf(tokenB)]);
    expect(seen.size).toBe(2);

    for (const token of [tokenA, tokenB]) {
      const res = await call(`/v2/user?usernames=${username}`, {
        authorization: `Bearer ${token}`,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { users: { username: string }[] };
      // 每个租户只能看到自己那一个同名账号，看不到另一个租户的。
      expect(body.users).toHaveLength(1);
      expect(body.users[0]?.username).toBe(username);
    }
  });
});
