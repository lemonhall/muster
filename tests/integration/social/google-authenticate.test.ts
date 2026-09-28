import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { authenticateGoogle, type GoogleDeps } from "../../../src/domain/social/google/authenticate";
import { tenantEnvOf } from "../../../src/http/auth";
import { Code } from "../../../src/http/grpc";
import { signingFixture, type SigningFixture } from "../../helpers/google-jwt";
import {
  authenticateDeviceOrFail,
  createTenant,
  deviceAuth,
  findUserByIdentity,
} from "../../helpers/tenants";

/**
 * Google 认证的账号侧：一次可信登录 → 一个账号 + 一个会话。
 *
 * 这一层只吃"档案"，不吃网络：证书由测试注入（`google-jwt.ts`），
 * 所以整份文件不产生任何外部请求。逐条对齐上游 `core_authenticate.go::AuthenticateGoogle`：
 * 建号时写入名字/头像/邮箱、老账号在字段为空时回填、用户名冲突 409、禁用账号 403、
 * `create=false` 且无账号 404、token 不合格 401。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_authenticate.go::AuthenticateGoogle
 * 契约源: server/core_authenticate.go::AuthenticateGoogle
 *
 * REQ-0001-003
 */

const TARGET = "target-client.apps.googleusercontent.com";

interface GoogleUserRow {
  readonly id: string;
  readonly username: string;
  readonly display_name: string;
  readonly avatar_url: string;
  readonly email: string | null;
}

async function newTenant(): Promise<string> {
  const tenantId = crypto.randomUUID().toUpperCase();
  await createTenant(tenantId, `server-key-${tenantId}`, "google");
  return tenantId;
}

function depsOf(fixture: SigningFixture): GoogleDeps {
  return { clientIds: [TARGET], certs: fixture.certs };
}

async function tokenFor(
  fixture: SigningFixture,
  claims: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return fixture.sign({
    iss: "https://accounts.google.com",
    aud: TARGET,
    sub: "google-subject-1",
    iat: now,
    exp: now + 600,
    ...claims,
  });
}

async function readUser(tenantId: string, userId: string): Promise<GoogleUserRow | null> {
  return env.DB.prepare(
    "SELECT id, username, display_name, avatar_url, email FROM users WHERE tenant_id = ?1 AND id = ?2",
  )
    .bind(tenantId, userId)
    .first<GoogleUserRow>();
}

async function identityOf(tenantId: string, providerId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT user_id FROM user_identity WHERE tenant_id = ?1 AND provider = 'google' AND provider_id = ?2",
  )
    .bind(tenantId, providerId)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

async function failureOf(promise: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    const apiError = error as { code?: number; message?: string };
    return { code: apiError.code ?? -1, message: apiError.message ?? "" };
  }
  throw new Error("这次调用本该失败，但它成功了");
}

describe("M5 契约: Google 认证的账号映射", () => {
  it("test_google_authentication_creates_an_account_from_a_verified_token", async () => {
    const fixture = await signingFixture();
    const tenantId = await newTenant();
    const envs = tenantEnvOf(env, tenantId, Math.floor(Date.now() / 1000));
    const token = await tokenFor(fixture, {
      name: "Synthetic Player",
      picture: "https://example.test/avatar.png",
      email: "synthetic@example.test",
    });

    const created = await authenticateGoogle(envs, { token, create: true }, depsOf(fixture));
    expect(created.created).toBe(true);

    const userId = await identityOf(tenantId, "google-subject-1");
    expect(userId).not.toBeNull();
    const user = await readUser(tenantId, userId ?? "");
    expect(user).toMatchObject({
      display_name: "Synthetic Player",
      avatar_url: "https://example.test/avatar.png",
      email: "synthetic@example.test",
    });

    // 同一个 Google 身份再登一次：不建新账号，`created=false`。
    const again = await authenticateGoogle(envs, { token, create: true }, depsOf(fixture));
    expect(again.created).toBe(false);
    expect(await identityOf(tenantId, "google-subject-1")).toBe(userId);
    expect(again.token).not.toBe(created.token);
  });

  it("test_google_authentication_backfills_an_empty_profile_from_google", async () => {
    const fixture = await signingFixture();
    const tenantId = await newTenant();
    const envs = tenantEnvOf(env, tenantId, Math.floor(Date.now() / 1000));

    const bare = await authenticateGoogle(envs, { token: await tokenFor(fixture), create: true }, depsOf(fixture));
    const userId = (await identityOf(tenantId, "google-subject-1")) ?? "";
    expect(await readUser(tenantId, userId)).toMatchObject({ display_name: "", avatar_url: "" });

    const rich = await tokenFor(fixture, { name: "Backfilled", picture: "https://example.test/p.png" });
    const second = await authenticateGoogle(envs, { token: rich, create: true }, depsOf(fixture));
    expect(second.created).toBe(false);
    expect(second.token).not.toBe(bare.token);
    expect(await readUser(tenantId, userId)).toMatchObject({
      display_name: "Backfilled",
      avatar_url: "https://example.test/p.png",
    });
  });

  it("test_google_authentication_requires_a_token", async () => {
    const fixture = await signingFixture();
    const tenantId = await newTenant();
    const failure = await failureOf(
      authenticateGoogle(tenantEnvOf(env, tenantId, 0), { token: "", create: true }, depsOf(fixture)),
    );
    expect(failure).toEqual({ code: Code.InvalidArgument, message: "Google access token is required." });
  });

  it("test_google_authentication_rejects_an_unverifiable_token", async () => {
    const fixture = await signingFixture();
    const tenantId = await newTenant();
    const failure = await failureOf(
      authenticateGoogle(
        tenantEnvOf(env, tenantId, Math.floor(Date.now() / 1000)),
        { token: "not.a.jwt", create: true },
        depsOf(fixture),
      ),
    );
    expect(failure).toEqual({ code: Code.Unauthenticated, message: "Could not authenticate Google profile." });
    expect(await identityOf(tenantId, "google-subject-1")).toBeNull();
  });

  it("test_google_authentication_reports_a_missing_account_when_creation_is_disabled", async () => {
    const fixture = await signingFixture();
    const tenantId = await newTenant();
    const failure = await failureOf(
      authenticateGoogle(
        tenantEnvOf(env, tenantId, Math.floor(Date.now() / 1000)),
        { token: await tokenFor(fixture), create: false },
        depsOf(fixture),
      ),
    );
    expect(failure).toEqual({ code: Code.NotFound, message: "User account not found." });
  });

  it("test_google_authentication_reports_a_username_already_in_use", async () => {
    const fixture = await signingFixture();
    const tenantId = await newTenant();
    const tenant = { id: tenantId, serverKey: `server-key-${tenantId}` };
    const response = await deviceAuth(tenant, `dev-${crypto.randomUUID()}`, "?create=true&username=taken-name");
    expect(response.status).toBe(200);

    const failure = await failureOf(
      authenticateGoogle(
        tenantEnvOf(env, tenantId, Math.floor(Date.now() / 1000)),
        { token: await tokenFor(fixture), username: "taken-name", create: true },
        depsOf(fixture),
      ),
    );
    expect(failure).toEqual({ code: Code.AlreadyExists, message: "Username is already in use." });
  });

  it("test_google_authentication_rejects_a_banned_account", async () => {
    const fixture = await signingFixture();
    const tenantId = await newTenant();
    const envs = tenantEnvOf(env, tenantId, Math.floor(Date.now() / 1000));
    const token = await tokenFor(fixture);
    await authenticateGoogle(envs, { token, create: true }, depsOf(fixture));

    const userId = (await identityOf(tenantId, "google-subject-1")) ?? "";
    await env.DB.prepare("UPDATE users SET disable_time = ?1 WHERE tenant_id = ?2 AND id = ?3")
      .bind(123, tenantId, userId)
      .run();

    const failure = await failureOf(authenticateGoogle(envs, { token, create: true }, depsOf(fixture)));
    expect(failure).toEqual({ code: Code.PermissionDenied, message: "User account banned." });
  });

  it("test_google_authentication_keeps_a_taken_email_out_of_the_way", async () => {
    const fixture = await signingFixture();
    const tenantId = await newTenant();
    const tenant = { id: tenantId, serverKey: `server-key-${tenantId}` };
    // 先占住这个邮箱：它属于另一个（设备）账号。
    const deviceId = `dev-${crypto.randomUUID()}`;
    await authenticateDeviceOrFail(tenant, deviceId);
    const deviceUserId = (await findUserByIdentity(tenantId, "device", deviceId))?.id ?? "";
    expect(deviceUserId).not.toBe("");
    await env.DB.prepare("UPDATE users SET email = ?1 WHERE tenant_id = ?2 AND id = ?3")
      .bind("contested@example.test", tenantId, deviceUserId)
      .run();

    // Google 带回来的邮箱已被别人占用：账号照样建，只是不写这个邮箱（上游那条 Warn）。
    const created = await authenticateGoogle(
      tenantEnvOf(env, tenantId, Math.floor(Date.now() / 1000)),
      { token: await tokenFor(fixture, { email: "contested@example.test" }), create: true },
      depsOf(fixture),
    );
    expect(created.created).toBe(true);
    const googleUserId = (await identityOf(tenantId, "google-subject-1")) ?? "";
    expect(await readUser(tenantId, googleUserId)).toMatchObject({ email: null });
  });
});
