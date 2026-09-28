import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { deriveTenantSessionKey, signSessionToken } from "../../src/domain/identity/token";
import {
  TENANT_A_REF,
  TEST_MASTER_SECRET,
  authenticateDeviceOrFail,
  basicAuth,
  bearer,
  call,
  createBothTenants,
  deviceAuth,
  findUserByIdentity,
  type SessionBody,
} from "../helpers/tenants";

/**
 * M1 契约测试：身份、会话与账号，逐条对齐上游可观测行为。
 *
 * 每条断言的期望值都来自上游源码（不是"看起来应该"），失败消息也逐字对齐——
 * 官方 SDK 会按这些字符串做分支，改一个字就是把 SDK 挡在门外。
 *
 * 契约源（机器可读）：
 * 契约源: server/api.go::securityInterceptorFunc
 * 契约源: server/api.go::parseBasicAuth
 * 契约源: server/api.go::wwwAuthenticateFixWriter
 * 契约源: server/api_authenticate.go::AuthenticateDevice
 * 契约源: server/api_authenticate.go::AuthenticateEmail
 * 契约源: server/api_authenticate.go::AuthenticateCustom
 * 契约源: server/api_session.go::SessionRefresh
 * 契约源: server/api_session.go::SessionLogout
 * 契约源: server/api_account.go::GetAccount
 * 契约源: server/api_account.go::UpdateAccount
 * 契约源: server/api_user.go::GetUsers
 * 契约源: server/core_authenticate.go::AuthenticateDevice
 * 契约源: server/core_authenticate.go::AuthenticateEmail
 * 契约源: server/core_session.go::SessionRefresh
 * 契约源: server/core_session.go::SessionLogout
 * 契约源: server/core_account.go::UpdateAccounts
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/account/authenticate/device
 *
 * REQ-0001-003, REQ-0001-004, REQ-0001-005
 */

const DEVICE = "device-id-000001";
const EMAIL = "player1@example.com";
const PASSWORD = "supersecret";

beforeAll(async () => {
  await createBothTenants();
});

async function errorBody(response: Response): Promise<{ code: number; message: string }> {
  return (await response.json()) as { code: number; message: string };
}

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
    // `GET /v2/friend` 在上游 REST 表里存在、本项目还没做 → 诚实地说"有、没做"。
    const res = await call("/v2/friend", { method: "GET" });
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

describe("M1 契约: 设备认证", () => {
  it("test_authenticate_device_creates_account_and_returns_session", async () => {
    const res = await deviceAuth(TENANT_A_REF, DEVICE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionBody;
    expect(body.created).toBe(true);
    expect(body.token.split(".")).toHaveLength(3);
    expect(body.refresh_token.split(".")).toHaveLength(3);

    // 用户 id 是规范大写 UUID（上游 uuid.Must(uuid.NewV4()).String()）。
    const user = await findUserByIdentity(TENANT_A_REF.id, "device", DEVICE);
    expect(user?.id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/u);
  });

  it("test_authenticate_device_twice_reuses_account_and_omits_created", async () => {
    const first = await deviceAuth(TENANT_A_REF, "device-id-000002");
    const second = await deviceAuth(TENANT_A_REF, "device-id-000002");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as SessionBody;
    // protojson 省略零值 → created=false 时整个键都不出现。
    expect("created" in secondBody).toBe(false);
    expect(secondBody.token).not.toBe(((await first.json()) as SessionBody).token);
  });

  it("test_authenticate_device_without_create_returns_404_when_unknown", async () => {
    const res = await deviceAuth(TENANT_A_REF, "device-id-000003", "?create=false");
    expect(res.status).toBe(404);
    expect(await errorBody(res)).toEqual({ code: 5, message: "User account not found." });
  });

  it("test_authenticate_device_rejects_short_id", async () => {
    const res = await deviceAuth(TENANT_A_REF, "short");
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({
      code: 3,
      message: "Device ID invalid, must be 10-128 bytes.",
    });
  });

  it("test_authenticate_device_rejects_id_with_spaces", async () => {
    const res = await deviceAuth(TENANT_A_REF, "device id 0004");
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({
      code: 3,
      message: "Device ID invalid, no spaces or control characters allowed.",
    });
  });

  it("test_authenticate_device_requires_id", async () => {
    const res = await call("/v2/account/authenticate/device?create=true", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: {},
    });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ code: 3, message: "Device ID is required." });
  });

  it("test_authenticate_device_with_username_conflict_returns_409", async () => {
    const taken = "taken-name-01";
    const first = await call(`/v2/account/authenticate/device?create=true&username=${taken}`, {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { id: "device-id-000010" },
    });
    expect(first.status).toBe(200);
    const second = await call(`/v2/account/authenticate/device?create=true&username=${taken}`, {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { id: "device-id-000011" },
    });
    expect(second.status).toBe(409);
    expect(await errorBody(second)).toEqual({ code: 6, message: "Username is already in use." });
  });

  it("test_authenticate_with_empty_body_reports_unexpected_eof", async () => {
    const res = await call("/v2/account/authenticate/device?create=true", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      rawBody: "",
    });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ code: 3, message: "unexpected EOF" });
  });

  it("test_authenticate_with_json_null_reports_missing_account", async () => {
    // 上游：body 解成 nil → `in.Account == nil` → 报的是"缺 ID"而不是 JSON 语法错。
    const res = await call("/v2/account/authenticate/device?create=true", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      rawBody: "null",
    });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ code: 3, message: "Device ID is required." });
  });

  it("test_create_query_defaults_to_true_when_absent", async () => {
    const res = await call("/v2/account/authenticate/device", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { id: "device-id-000012" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SessionBody).created).toBe(true);
  });
});

describe("M1 契约: 自定义认证", () => {
  it("test_authenticate_custom_requires_six_bytes", async () => {
    const res = await call("/v2/account/authenticate/custom?create=true", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { id: "abcde" },
    });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ code: 3, message: "Custom ID invalid, must be 6-128 bytes." });
  });

  it("test_authenticate_custom_creates_account", async () => {
    const res = await call("/v2/account/authenticate/custom?create=true", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { id: "custom-id-01" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SessionBody).created).toBe(true);
  });
});

describe("M1 契约: 邮箱认证", () => {
  it("test_authenticate_email_creates_account_then_logs_in", async () => {
    const created = await call("/v2/account/authenticate/email?create=true", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(created.status).toBe(200);
    expect(((await created.json()) as SessionBody).created).toBe(true);

    const again = await call("/v2/account/authenticate/email?create=true", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(again.status).toBe(200);
    // 同邮箱同密码 = 登录成功，不是"重复注册"。created 被省略。
    expect("created" in ((await again.json()) as SessionBody)).toBe(false);
  });

  it("test_authenticate_email_with_wrong_password_returns_401_invalid_credentials", async () => {
    const res = await call("/v2/account/authenticate/email", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { email: EMAIL, password: "wrong-password" },
    });
    expect(res.status).toBe(401);
    expect(await errorBody(res)).toEqual({ code: 16, message: "Invalid credentials." });
  });

  it("test_authenticate_email_unknown_without_create_returns_404", async () => {
    const res = await call("/v2/account/authenticate/email?create=false", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { email: "nobody@example.com", password: PASSWORD },
    });
    expect(res.status).toBe(404);
    expect(await errorBody(res)).toEqual({ code: 5, message: "User account not found." });
  });

  it("test_authenticate_email_rejects_short_password", async () => {
    const res = await call("/v2/account/authenticate/email", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { email: EMAIL, password: "short" },
    });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({
      code: 3,
      message: "Password must be at least 8 characters long.",
    });
  });

  it("test_authenticate_email_rejects_bad_format", async () => {
    const res = await call("/v2/account/authenticate/email", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { email: "not-an-email", password: PASSWORD },
    });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ code: 3, message: "Invalid email address format." });
  });

  it("test_authenticate_email_rejects_too_short_address", async () => {
    const res = await call("/v2/account/authenticate/email", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { email: "a@b.c", password: PASSWORD },
    });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({
      code: 3,
      message: "Invalid email address, must be 10-255 bytes.",
    });
  });

  it("test_authenticate_email_with_short_username_reports_username_length", async () => {
    // 上游先查邮箱格式、再查密码长度、最后查用户名；这里三个都错时先报邮箱。
    const res = await call("/v2/account/authenticate/email?username=%20bad%20", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { email: "bad-email", password: "x" },
    });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ code: 3, message: "Invalid email address format." });
  });

  it("test_authenticate_email_without_email_falls_back_to_username_login", async () => {
    const signup = await call("/v2/account/authenticate/email?create=true&username=email-login-user", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { email: "email-login@example.com", password: PASSWORD },
    });
    expect(signup.status).toBe(200);

    // 邮箱为空时用户名从 query 来；没给用户名就是缺参数。
    const missing = await call("/v2/account/authenticate/email", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { email: "", password: PASSWORD },
    });
    expect(missing.status).toBe(400);
    expect(await errorBody(missing)).toEqual({
      code: 3,
      message: "Username is required when email address is not supplied.",
    });

    const byUsername = await call("/v2/account/authenticate/email?username=email-login-user", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { email: "", password: PASSWORD },
    });
    expect(byUsername.status).toBe(200);
    expect("created" in ((await byUsername.json()) as SessionBody)).toBe(false);

    // 这条路径上的错误密码同样是 Invalid credentials（不区分"没设密码"）。
    const wrong = await call("/v2/account/authenticate/email?username=email-login-user", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { email: "", password: "wrong-password" },
    });
    expect(wrong.status).toBe(401);
    expect(await errorBody(wrong)).toEqual({ code: 16, message: "Invalid credentials." });
  });

  it("test_authenticate_email_ignores_create_flag_on_username_login", async () => {
    // 用户名 + 密码路径永不允许建号：create=true 也不会新建。
    const res = await call("/v2/account/authenticate/email?create=true&username=ghost-user", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      body: { email: "", password: PASSWORD },
    });
    expect(res.status).toBe(404);
    expect(await errorBody(res)).toEqual({ code: 5, message: "User account not found." });
  });

  it("test_authenticate_email_without_account_object_reports_account_required", async () => {
    const res = await call("/v2/account/authenticate/email", {
      authorization: basicAuth(TENANT_A_REF.serverKey),
      rawBody: "null",
    });
    expect(res.status).toBe(400);
    expect(await errorBody(res)).toEqual({ code: 3, message: "Email address and password is required." });
  });
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
