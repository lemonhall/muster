import { env } from "cloudflare:test";

import { setIapTransport } from "../../src/domain/iap/transport";
import type { IapHttpResponse, IapTransport } from "../../src/domain/iap/types";
import {
  authenticateDeviceOrFail,
  bearer,
  call,
  createTenant,
  findUserByIdentity,
  type TestTenant,
} from "./tenants";

/**
 * M9 内购套件的工装。
 *
 * 两件事都刻意做得**显式**：
 *   - 厂商调用被替换成一个记账用的假 transport（记下每次的 URL 与请求体），
 *     测试既能看到"请求长什么样"，又能断言"根本没出网"；
 *   - Apple 的 shared secret 通过绑定注入/清空，用来覆盖"provider 没配"这条路径。
 *
 * 文件名不带 `.test.ts`，不会被 vitest 收集。
 */

export interface VendorCall {
  readonly url: string;
  readonly payload: unknown;
}

export interface FakeVendor {
  readonly calls: VendorCall[];
  /** 第 n 次调用回哪一条；用完了就继续用最后一条。 */
  readonly replies: readonly IapHttpResponse[];
}

/** 装上假 transport 并返回它的账本。`afterAll` 里用 `setIapTransport(null)` 还原。 */
export function fakeVendor(replies: readonly IapHttpResponse[]): FakeVendor {
  const vendor: FakeVendor = { calls: [], replies };
  const transport: IapTransport = async (url, payload) => {
    const index = Math.min(vendor.calls.length, replies.length - 1);
    vendor.calls.push({ url, payload });
    return replies[index] as IapHttpResponse;
  };
  setIapTransport(transport);
  return vendor;
}

/** 一个同时记事的 transport，永不返回（用于断言"根本没调用厂商"）。 */
export function silentVendor(): FakeVendor {
  return fakeVendor([{ status: 500, body: "unexpected vendor call" }]);
}

const MUTABLE = env as unknown as Record<string, unknown>;

export function configureApple(password?: string): void {
  if (password === undefined) delete MUTABLE.IAP_APPLE_SHARED_PASSWORD;
  else MUTABLE.IAP_APPLE_SHARED_PASSWORD = password;
}

export interface IapWorld {
  readonly tenant: TestTenant;
  readonly token: string;
  readonly userId: string;
}

/** 新租户 + 一个新玩家（只走认证端点，不碰内购路由）。 */
export async function iapWorld(): Promise<IapWorld> {
  const id = crypto.randomUUID().toUpperCase();
  const tenant = await createTenant(id, `server-key-${id}`, "iap");
  const deviceId = `dev-${crypto.randomUUID()}`;
  const session = await authenticateDeviceOrFail(tenant, deviceId);
  const user = await findUserByIdentity(tenant.id, "device", deviceId);
  if (user === null) throw new Error("认证之后应该在 users 表里找到这个人");
  return { tenant, token: session.token, userId: user.id };
}

export interface PurchaseRow {
  readonly id: string;
  readonly user_id: string;
  readonly store: number;
  readonly product_id: string;
  readonly transaction_id: string;
  readonly purchase_time: number;
  readonly environment: number;
  readonly seen_before: number;
  readonly raw_response: string;
  readonly create_time: number;
  readonly update_time: number;
}

/** 直接读库：断言"账本里有没有行"，而不是只看 HTTP 响应。 */
export async function purchaseRows(tenantId: string): Promise<PurchaseRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, user_id, store, product_id, transaction_id, purchase_time, environment,
            seen_before, raw_response, create_time, update_time
     FROM purchase WHERE tenant_id = ?1 ORDER BY create_time, transaction_id`,
  )
    .bind(tenantId)
    .all<PurchaseRow>();
  return result.results;
}

export function purchaseCall(
  world: IapWorld,
  body: unknown,
  provider = "apple",
): Promise<Response> {
  return call(`/v2/iap/purchase/${provider}`, {
    authorization: bearer(world.token),
    body,
  });
}

export function purchaseCallRaw(world: IapWorld, rawBody: string, provider = "apple"): Promise<Response> {
  return call(`/v2/iap/purchase/${provider}`, {
    authorization: bearer(world.token),
    rawBody,
  });
}

/** 一条合法的 Apple 响应：一笔非订阅交易。 */
export function appleReceiptBody(
  transactionId: string,
  options: { readonly environment?: string; readonly productId?: string; readonly expires?: string } = {},
): string {
  return JSON.stringify({
    status: 0,
    environment: options.environment ?? "Production",
    receipt: {
      in_app: [
        {
          transaction_id: transactionId,
          product_id: options.productId ?? "coins-100",
          purchase_date_ms: "1700000000000",
          ...(options.expires === undefined ? {} : { expires_date_ms: options.expires }),
        },
      ],
    },
  });
}

export async function errorBodyOf(response: Response): Promise<{ code: number; message: string }> {
  return (await response.json()) as { code: number; message: string };
}
