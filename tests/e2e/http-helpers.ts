import { expect } from "vitest";

/**
 * E2E 共用工装：真实 HTTP 通道上反复要用的那几件事，收在一处。
 *
 * 文件名刻意**不带** `.e2e.test.ts` 后缀，所以不会被 vitest 当成测试文件收集
 * （e2e 配置只收集 `tests/e2e` 下的 `.e2e.test.ts`）；只有需要它的用例文件才 import。
 */
export const baseUrl =
  process.env.MUSTER_E2E_TARGET ?? `http://127.0.0.1:${process.env.MUSTER_E2E_PORT ?? "8788"}`;

export interface TenantRef {
  readonly id: string;
  readonly serverKey: string;
}

export interface HttpCall {
  readonly method?: string;
  /** 完整的 Authorization 头值（要看 `Basic` 之类的非 Bearer 形状时用它）。 */
  readonly authorization?: string;
  /** 便利写法：等价于 `authorization: "Bearer <token>"`。 */
  readonly token?: string;
  readonly body?: unknown;
}

export function call(path: string, options: HttpCall = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const authorization =
    options.authorization ?? (options.token === undefined ? undefined : `Bearer ${options.token}`);
  if (authorization !== undefined) headers["authorization"] = authorization;
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

/** `Authorization: Basic base64(<server_key>:)`，与官方 SDK 的写法一致。 */
export function basic(serverKey: string): string {
  return `Basic ${Buffer.from(`${serverKey}:`, "utf8").toString("base64")}`;
}

export interface SessionBody {
  readonly created?: boolean;
  readonly token: string;
  readonly refresh_token: string;
}

/** 每次运行都用新的设备 ID：本地 D1 是跨运行保留的，固定 ID 会让断言依赖"上一轮"。 */
export function freshDeviceId(prefix = "e2e"): string {
  return `${prefix}-device-${crypto.randomUUID()}`;
}

export async function authenticateDevice(
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

export async function accountOf(token: string): Promise<Record<string, unknown>> {
  const res = await call("/v2/account", { token });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

export async function userIdOf(token: string): Promise<string> {
  const account = await accountOf(token);
  return (account.user as { id: string }).id;
}

/** 断言失败响应是上游形状的 google.rpc.Status。 */
export async function expectStatus(
  response: Response,
  status: number,
  code: number,
  message: string,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(await response.json()).toEqual({ code, message });
}
