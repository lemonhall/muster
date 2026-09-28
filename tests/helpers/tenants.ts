import { env, SELF } from "cloudflare:test";
import { sha256Hex } from "../../src/domain/tenancy/store";

/**
 * 测试用的租户工装。
 *
 * 这里**直接写 D1**，而不是调 `scripts/tenant.mjs`：CLI 是给运维用的，
 * 测试不该依赖"某个外部命令正好可用"。测试要的是"表里有这条记录"这个事实。
 */

export interface TestTenant {
  readonly id: string;
  readonly serverKey: string;
}

/** 固定的租户 id：用规范大写 UUID，跟真实开通出来的形状一致。 */
export const TENANT_A = "AAAAAAAA-0000-4000-8000-000000000001";
export const TENANT_B = "BBBBBBBB-0000-4000-8000-000000000002";
export const SERVER_KEY_A = "test-server-key-aaaa";
export const SERVER_KEY_B = "test-server-key-bbbb";

/** 两个租户的现成引用，测试里直接当参数用。 */
export const TENANT_A_REF: TestTenant = { id: TENANT_A, serverKey: SERVER_KEY_A };
export const TENANT_B_REF: TestTenant = { id: TENANT_B, serverKey: SERVER_KEY_B };

/** 测试主密钥，与 vitest.config.ts 注入的 SESSION_ENCRYPTION_KEY 保持一致。 */
export const TEST_MASTER_SECRET = "test-only-session-encryption-key";

export async function createTenant(id: string, serverKey: string, name = "test"): Promise<TestTenant> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO tenants (id, name, server_key_hash, create_time, disable_time) VALUES (?1, ?2, ?3, ?4, 0)",
  )
    .bind(id, name, await sha256Hex(serverKey), now)
    .run();
  return { id, serverKey };
}

export async function createBothTenants(): Promise<{ a: TestTenant; b: TestTenant }> {
  await env.DB.prepare("DELETE FROM tenants").run();
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare("DELETE FROM user_identity").run();
  await env.DB.prepare("DELETE FROM sessions").run();
  return {
    a: await createTenant(TENANT_A, SERVER_KEY_A, "tenant-a"),
    b: await createTenant(TENANT_B, SERVER_KEY_B, "tenant-b"),
  };
}

export interface UserRowSnapshot {
  readonly id: string;
  readonly username: string;
}

/** 按身份反查用户：测试里想知道"这个 device/custom/email 落在哪个账号上"。 */
export async function findUserByIdentity(
  tenantId: string,
  provider: string,
  providerId: string,
): Promise<UserRowSnapshot | null> {
  return env.DB.prepare(
    "SELECT u.id AS id, u.username AS username FROM users u " +
      "JOIN user_identity i ON i.tenant_id = u.tenant_id AND i.user_id = u.id " +
      "WHERE u.tenant_id = ?1 AND i.provider = ?2 AND i.provider_id = ?3",
  )
    .bind(tenantId, provider, providerId)
    .first<UserRowSnapshot>();
}

/** `Authorization: Basic base64(<server_key>:)`，与客户端 SDK 的写法一致。 */
export function basicAuth(serverKey: string): string {
  return `Basic ${btoa(`${serverKey}:`)}`;
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}

const BASE = "https://muster.test";

export interface CallOptions {
  readonly method?: string;
  readonly authorization?: string;
  readonly body?: unknown;
  /** 传 `null` 表示"发一个 JSON null"，用于测上游 `in.Account == nil` 分支。 */
  readonly rawBody?: string;
  /** 显式带一个 `x-request-id`（DoD 8 的"沿用客户端 id"那一半）。 */
  readonly requestId?: string;
}

export function call(path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.authorization !== undefined) headers["authorization"] = options.authorization;
  if (options.requestId !== undefined) headers["x-request-id"] = options.requestId;
  const body =
    options.rawBody !== undefined
      ? options.rawBody
      : options.body === undefined
        ? undefined
        : JSON.stringify(options.body);
  return SELF.fetch(`${BASE}${path}`, {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

export interface SessionBody {
  readonly created?: boolean;
  readonly token: string;
  readonly refresh_token: string;
}

export function deviceAuth(
  tenant: TestTenant,
  deviceId: string,
  query = "?create=true",
): Promise<Response> {
  return call(`/v2/account/authenticate/device${query}`, {
    authorization: basicAuth(tenant.serverKey),
    body: { id: deviceId },
  });
}

export async function authenticateDeviceOrFail(tenant: TestTenant, deviceId: string): Promise<SessionBody> {
  const response = await deviceAuth(tenant, deviceId);
  if (response.status !== 200) {
    throw new Error(`authenticate device 失败：${response.status} ${await response.text()}`);
  }
  return (await response.json()) as SessionBody;
}
