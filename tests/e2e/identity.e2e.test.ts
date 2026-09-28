import { describe, expect, it } from "vitest";

import { e2eTenant } from "./global-setup";
import {
  accountOf,
  authenticateDevice,
  basic,
  call,
  expectStatus,
  freshDeviceId,
  userIdOf,
  type SessionBody,
} from "./http-helpers";

/**
 * M1 E2E：身份 / 会话 / 账号，走真实 HTTP 通道。
 *
 * 与 `tests/integration/identity/` 下的集成测试的分工是刻意的：
 * - 集成测试直接 import 处理器，断言的是**领域语义**（校验顺序、错误文案、边界）；
 * - 这里只碰网络，断言的是**端到端真的成立**：HTTP 头、状态码、序列化、D1 落库、
 *   以及多租户隔离在真实请求下依然成立。
 *
 * 目标是一个本地 `wrangler dev --local` 进程（见 `global-setup.ts`），
 * 不连接任何 Cloudflare 账号资源，因此不产生账单。
 *
 * 多租户隔离的用例刻意不在这个文件里，而在同目录的 `tenancy.e2e.test.ts`：
 * 一个文件只回答一个问题，坏掉时能一眼看出是哪一半坏。
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

  it("test_unimplemented_domains_and_auth_kinds_over_real_http", async () => {
    const { session } = await authenticateDevice(e2eTenant, freshDeviceId());

    // 上游有、本项目还没实现的域 → 诚实地说"这条路有、我们还没做"，不假装 404。
    const notImplemented = await call("/v2/channel/room-1", {
      authorization: `Bearer ${session.token}`,
    });
    await expectStatus(notImplemented, 501, 12, "Not implemented.");

    // 路径已实现但方法不符 → 501 `Method Not Allowed`（上游 handleRoutingError 把 405
    // 折叠成 codes.Unimplemented，所以状态码是 501 而不是 405）。
    // 注意别拿 GET 试 `/v2/storage/delete`：那条会被 `/v2/storage/{collection}` 抢走，
    // 变成"列举名为 delete 的集合"，上游也是这个行为。
    const wrongMethod = await call("/v2/storage/delete", {
      method: "POST",
      authorization: `Bearer ${session.token}`,
      body: {},
    });
    await expectStatus(wrongMethod, 501, 12, "Method Not Allowed");

    // 存储域在上游拦截器里走的是 default 分支：**只认 Bearer**。
    // 拿 server key 走 Basic 打过来会落到 parseBearerAuth 失败 → 401 `Auth token invalid`
    // （不是 `Server key invalid`，也不是 403）。
    const withServerKey = await call("/v2/storage", {
      method: "PUT",
      authorization: basic(e2eTenant.serverKey),
      body: {},
    });
    await expectStatus(withServerKey, 401, 16, "Auth token invalid");
  });
});
