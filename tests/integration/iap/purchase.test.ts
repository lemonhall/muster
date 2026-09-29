import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setIapTransport } from "../../../src/domain/iap/transport";
import {
  appleReceiptBody,
  configureApple,
  fakeVendor,
  iapWorld,
  purchaseCall,
  purchaseRows,
} from "../../helpers/iap";

/**
 * M9 内购（DoD 10）：Apple 传统 `verifyReceipt` 的**成功路径**。
 *
 * 这里的每一条都在钉一件**可观测**的事，而不是"返回了 200"：
 *
 *   - 校验通过的收据必须真的落进 `purchase` 表（读库断言，不看响应体自说自话）；
 *   - 重放同一条交易号**不新增行**、且回报 `seen_before`（幂等，不是"再来一笔"）；
 *   - `persist=false` 校验但不落库（消费级客户端只想验一次，不想留账本）；
 *   - 沙盒收据（生产端点回 21007）必须**改打沙盒端点重试一次**，且两跳的 URL 与次数都被钉住；
 *   - 发往 Apple 的请求体逐字对齐上游，包括 `exclude-old-transactions`。
 *
 * 厂商调用全部走**注入的假 transport**（ECN-0014 偏差 5）：测试与 CI 都**不出网**，
 * 不打 Apple、不花钱、不依赖沙盒收据的有效期。`afterAll` 把它还原成真 `fetch`。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_purchase.go::ValidatePurchaseApple
 * 契约源: server/core_purchase.go::validateLegacyPurchaseReceiptApple
 * 契约源: iap/iap.go::ValidateLegacyReceiptApple
 *
 * REQ-0001-022
 */

const APPLE_PRODUCTION_URL = "https://buy.itunes.apple.com/verifyReceipt";
const APPLE_SANDBOX_URL = "https://sandbox.itunes.apple.com/verifyReceipt";
const SHARED_PASSWORD = "test-shared-password";

beforeAll(() => {
  // 有 shared secret 才算"这个 provider 开着"。守卫路径另有专门用例。
  configureApple(SHARED_PASSWORD);
});

afterAll(() => {
  configureApple(undefined);
  setIapTransport(null);
});

/** 厂商 200 + 一份合法收据。 */
function appleReply(body: string): { readonly status: number; readonly body: string } {
  return { status: 200, body };
}

interface PurchaseView {
  readonly user_id?: string;
  readonly product_id?: string;
  readonly transaction_id?: string;
  readonly store?: number;
  readonly purchase_time?: string;
  readonly create_time?: string;
  readonly update_time?: string;
  readonly environment?: number;
  readonly provider_response?: string;
  readonly seen_before?: boolean;
}

async function purchasesOf(response: Response): Promise<PurchaseView[]> {
  const body = (await response.json()) as { validated_purchases?: PurchaseView[] };
  return body.validated_purchases ?? [];
}

describe("M9 内购: Apple verifyReceipt 成功路径", () => {
  it("test_a_valid_receipt_is_validated_persisted_and_returned", async () => {
    const receiptReply = appleReceiptBody("tx-1");
    const vendor = fakeVendor([appleReply(receiptReply)]);
    const world = await iapWorld();

    const response = await purchaseCall(world, { receipt: "synthetic-receipt" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");

    const purchases = await purchasesOf(response);
    expect(purchases).toHaveLength(1);
    const purchase = purchases[0] as PurchaseView;
    expect(purchase.user_id).toBe(world.userId);
    expect(purchase.product_id).toBe("coins-100");
    expect(purchase.transaction_id).toBe("tx-1");
    // purchase_date_ms = 1700000000000 → Unix 秒 → RFC3339（protojson 的 Timestamp）。
    expect(purchase.purchase_time).toBe("2023-11-14T22:13:20Z");
    expect(purchase.environment).toBe(2);
    expect(typeof purchase.create_time).toBe("string");
    expect(typeof purchase.update_time).toBe("string");
    // 原文进 provider_response：排障时要能看到 Apple 到底回了什么。
    expect(purchase.provider_response).toBe(receiptReply);
    // Apple = 0，protojson 零值省略；首次校验不是重放。
    expect(purchase).not.toHaveProperty("store");
    expect(purchase).not.toHaveProperty("seen_before");

    // 账本里确实有一行，且字段与响应一致。
    const rows = await purchaseRows(world.tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.transaction_id).toBe("tx-1");
    expect(rows[0]?.store).toBe(0);
    expect(rows[0]?.environment).toBe(2);
    expect(rows[0]?.seen_before).toBe(0);
    expect(rows[0]?.purchase_time).toBe(1_700_000_000);

    // 请求体逐字对齐上游：receipt-data / exclude-old-transactions / password。
    expect(vendor.calls).toHaveLength(1);
    expect(vendor.calls[0]?.url).toBe(APPLE_PRODUCTION_URL);
    expect(vendor.calls[0]?.payload).toEqual({
      "receipt-data": "synthetic-receipt",
      "exclude-old-transactions": true,
      password: SHARED_PASSWORD,
    });
  });

  it("test_a_replayed_receipt_is_idempotent_and_reports_seen_before", async () => {
    const vendor = fakeVendor([
      appleReply(appleReceiptBody("tx-replay")),
      appleReply(appleReceiptBody("tx-replay")),
    ]);
    const world = await iapWorld();

    const first = await purchaseCall(world, { receipt: "synthetic-receipt" });
    expect(first.status).toBe(200);
    expect((await purchasesOf(first))[0]).not.toHaveProperty("seen_before");

    const second = await purchaseCall(world, { receipt: "synthetic-receipt" });
    expect(second.status).toBe(200);
    const replayed = (await purchasesOf(second))[0] as PurchaseView;
    expect(replayed.transaction_id).toBe("tx-replay");
    expect(replayed.seen_before).toBe(true);

    // 幂等：同一条交易号只占一行；但客户端确实校验了两次（两跳都打给 Apple）。
    expect(await purchaseRows(world.tenant.id)).toHaveLength(1);
    expect(vendor.calls).toHaveLength(2);
  });

  it("test_persist_false_validates_without_writing_the_ledger", async () => {
    fakeVendor([appleReply(appleReceiptBody("tx-ephemeral"))]);
    const world = await iapWorld();

    const response = await purchaseCall(world, {
      receipt: "synthetic-receipt",
      persist: false,
    });
    expect(response.status).toBe(200);
    const purchase = (await purchasesOf(response))[0] as PurchaseView;
    expect(purchase.transaction_id).toBe("tx-ephemeral");
    // 上游 persist=false 分支不落库，也就没有 create/update/seen_before。
    expect(purchase).not.toHaveProperty("create_time");
    expect(purchase).not.toHaveProperty("update_time");
    expect(purchase).not.toHaveProperty("seen_before");

    expect(await purchaseRows(world.tenant.id)).toEqual([]);
  });

  it("test_a_sandbox_receipt_is_retried_against_the_sandbox_endpoint", async () => {
    const vendor = fakeVendor([
      // 生产端点回 21007：这是 Apple 的"收据来自沙盒"约定，不是错误。
      { status: 200, body: JSON.stringify({ status: 21007 }) },
      appleReply(appleReceiptBody("tx-sandbox", { environment: "Sandbox" })),
    ]);
    const world = await iapWorld();

    const response = await purchaseCall(world, { receipt: "synthetic-receipt" });
    expect(response.status).toBe(200);
    const purchase = (await purchasesOf(response))[0] as PurchaseView;
    expect(purchase.transaction_id).toBe("tx-sandbox");
    // 沙盒响应把 environment 折成 1（SANDBOX）。
    expect(purchase.environment).toBe(1);

    // 两跳：先生产、再沙盒，顺序不能反。
    expect(vendor.calls.map((call) => call.url)).toEqual([APPLE_PRODUCTION_URL, APPLE_SANDBOX_URL]);
  });

  it("test_only_the_non_subscription_item_is_persisted", async () => {
    const mixed = JSON.stringify({
      status: 0,
      environment: "Production",
      receipt: {
        in_app: [
          // 订阅交易（expires_date_ms 非空）必须被跳过：订阅走另一个端点。
          {
            transaction_id: "tx-subscription",
            product_id: "vip-monthly",
            purchase_date_ms: "1700000000000",
            expires_date_ms: "1702600000000",
          },
          {
            transaction_id: "tx-consumable",
            product_id: "coins-100",
            purchase_date_ms: "1700000000000",
          },
        ],
      },
    });
    fakeVendor([appleReply(mixed)]);
    const world = await iapWorld();

    const response = await purchaseCall(world, { receipt: "synthetic-receipt" });
    expect(response.status).toBe(200);
    expect((await purchasesOf(response)).map((entry) => entry.transaction_id)).toEqual([
      "tx-consumable",
    ]);
    expect((await purchaseRows(world.tenant.id)).map((row) => row.transaction_id)).toEqual([
      "tx-consumable",
    ]);
  });
});
