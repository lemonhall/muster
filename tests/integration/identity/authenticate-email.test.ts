/**
 * M1 契约测试：邮箱认证
 *
 * 拆自原 `tests/integration/identity.test.ts`（文件太长，按主题分家）。
 * 共享常量与整份契约源清单见 `tests/helpers/identity-fixtures.ts`。
 * 测试只跑本地 workerd + 本地 D1，不碰任何 Cloudflare 远端资源。
 */

import { beforeAll, describe, expect, it } from "vitest";

import { EMAIL, PASSWORD, errorBody } from "../../helpers/identity-fixtures";
import { type SessionBody, TENANT_A_REF, basicAuth, call, createBothTenants } from "../../helpers/tenants";

beforeAll(async () => {
  await createBothTenants();
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

