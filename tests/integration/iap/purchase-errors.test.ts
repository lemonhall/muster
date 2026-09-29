import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { setIapTransport } from "../../../src/domain/iap/transport";
import {
  appleReceiptBody,
  configureApple,
  errorBodyOf,
  fakeVendor,
  iapWorld,
  purchaseCall,
  purchaseCallRaw,
  purchaseRows,
  silentVendor,
} from "../../helpers/iap";
import { bearer, call } from "../../helpers/tenants";

/**
 * M9 内购（DoD 10）：**拒绝路径**。DoD 要求四条各自独立可判的拒绝：
 *   ① 伪造收据（厂商回 `status != 0`）被拒，且**不带出任何账本副作用**；
 *   ② 未配置凭据的 provider 报明确错误（不是偷偷放行）；
 *   ③ 请求体非 JSON；
 *   ④ 缺 `receipt` 字段。
 *
 * 后两条是**不同的**失败：非 JSON 是"请求根本没法解"，缺 receipt 是"结构对但字段空"。
 * 把它们折成一条就不能告诉客户端到底该改哪儿。
 *
 * 所有厂商调用都走注入的假 transport（ECN-0014 偏差 5）；守卫路径用 `silentVendor()`
 * 的**调用计数 = 0** 来证明"根本没出网"——这是"未配置就不该外呼"的证据，而不是看文案。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_purchase.go::ValidatePurchaseApple
 * 契约源: server/api_purchase.go::ValidatePurchaseGoogle
 * 契约源: server/api_purchase.go::ValidatePurchaseHuawei
 * 契约源: server/api_purchase.go::ValidatePurchaseFacebookInstant
 * 契约源: iap/iap.go::ValidateLegacyReceiptAppleWithUrl
 *
 * REQ-0001-022
 */

const FAILED_PRECONDITION = 9;
const INVALID_ARGUMENT = 3;
const UNKNOWN = 2;
const UNIMPLEMENTED = 12;

beforeAll(() => {
  configureApple("test-shared-password");
});

afterAll(() => {
  configureApple(undefined);
  setIapTransport(null);
});

// 每条用例自己装一个假 transport；跑完还原，免得上一条的账本漏进下一条。
afterEach(() => {
  setIapTransport(null);
});

describe("M9 内购: 伪造收据与厂商失败", () => {
  it("test_a_forged_receipt_is_rejected_without_touching_the_ledger", async () => {
    fakeVendor([{ status: 200, body: JSON.stringify({ status: 21003 }) }]);
    const world = await iapWorld();

    const response = await purchaseCall(world, { receipt: "forged-receipt" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: FAILED_PRECONDITION,
      message: "Invalid Receipt. Status: 21003",
    });
    // 关键：拒绝时不带出任何账本副作用。
    expect(await purchaseRows(world.tenant.id)).toEqual([]);
  });

  it("test_a_retryable_apple_failure_reports_try_again_later", async () => {
    fakeVendor([
      { status: 200, body: JSON.stringify({ status: 21003, is_retryable: true }) },
    ]);
    const world = await iapWorld();

    const response = await purchaseCall(world, { receipt: "forged-receipt" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: FAILED_PRECONDITION,
      message: "Apple IAP verification is currently unavailable. Try again later.",
    });
    expect(await purchaseRows(world.tenant.id)).toEqual([]);
  });

  it("test_a_subscription_only_receipt_points_at_the_subscription_surface", async () => {
    fakeVendor([
      {
        status: 200,
        body: appleReceiptBody("tx-sub", { expires: "1702600000000", productId: "vip-monthly" }),
      },
    ]);
    const world = await iapWorld();

    const response = await purchaseCall(world, { receipt: "synthetic-receipt" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: FAILED_PRECONDITION,
      message: "Subscription Receipt. Use the appropriate function instead.",
    });
    expect(await purchaseRows(world.tenant.id)).toEqual([]);
  });

  it("test_a_non_200_vendor_response_surfaces_as_unknown_with_the_raw_detail", async () => {
    fakeVendor([{ status: 502, body: "upstream boom" }]);
    const world = await iapWorld();

    const response = await purchaseCall(world, { receipt: "synthetic-receipt" });
    // 上游把裸错误交给 gRPC，code 落到 Unknown（HTTP 500）；消息里保留状态码与原文。
    expect(response.status).toBe(500);
    const body = await errorBodyOf(response);
    expect(body.code).toBe(UNKNOWN);
    expect(body.message).toBe(
      "non-200 response from Apple service, status=502, payload=upstream boom",
    );
    expect(await purchaseRows(world.tenant.id)).toEqual([]);
  });
});

describe("M9 内购: 配置守卫与入参校验", () => {
  it("test_apple_without_a_shared_secret_is_not_configured_and_never_calls_out", async () => {
    configureApple(undefined);
    const vendor = silentVendor();
    const world = await iapWorld();

    try {
      const response = await purchaseCall(world, { receipt: "synthetic-receipt" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        code: FAILED_PRECONDITION,
        message: "Apple IAP is not configured.",
      });
      // 未配置就是"这个 provider 没开"：一次都不该外呼。
      expect(vendor.calls).toHaveLength(0);
      expect(await purchaseRows(world.tenant.id)).toEqual([]);
    } finally {
      configureApple("test-shared-password");
    }
  });

  it("test_a_non_json_body_is_rejected_before_the_receipt_is_parsed", async () => {
    const vendor = silentVendor();
    const world = await iapWorld();

    const response = await purchaseCallRaw(world, "{ this is not json");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: INVALID_ARGUMENT, message: "Invalid JSON body." });
    expect(vendor.calls).toHaveLength(0);
  });

  it("test_a_missing_receipt_field_is_rejected_without_calling_out", async () => {
    const vendor = silentVendor();
    const world = await iapWorld();

    const response = await purchaseCall(world, {});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: INVALID_ARGUMENT,
      message: "Receipt cannot be empty.",
    });
    expect(vendor.calls).toHaveLength(0);
  });
});

describe("M9 内购: 未实现的 provider 与订阅面", () => {
  it.each([
    ["google", "Google IAP is not configured."],
    ["huawei", "Huawei IAP is not configured."],
    ["facebookinstant", "Facebook Instant IAP is not configured."],
  ])("test_the_%s_guard_reports_not_configured", async (provider, message) => {
    const world = await iapWorld();
    const response = await purchaseCall(world, { receipt: "synthetic-receipt" }, provider);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: FAILED_PRECONDITION, message });
  });

  it("test_samsung_and_the_subscription_surface_are_honestly_unimplemented", async () => {
    const world = await iapWorld();

    // 上游的 Samsung 校验走公开订单接口、不需要凭据，"未配置"说不通；订阅面本里程碑不做。
    // 两者都落 router 的上游对账分支，对外统一是 **501 + code 12**——"这条路有、我们还没做"。
    //
    // 消息两两不同，原因在上游对账表的形状而不是本项目的取舍：
    //   - `/v2/iap/purchase/samsung` 与 `/v2/iap/subscription` 只有字面量模板命中 → `Not implemented.`；
    //   - `/v2/iap/subscription/{apple,google}` 会先撞上上游那条通配模板
    //     `GET /v2/iap/subscription/{productId}`，对账面按插入序取首个命中，于是报文是
    //     `Method Not Allowed`（`POST` 不在那条模板的方法集里）。
    //     这不是"把存在的方法说成不存在"的谎：两条分支的 status 与 code 都是 501 / 12，
    //     客户端得到的结论一致——这个面还没实现。
    const expectations: readonly (readonly [string, string])[] = [
      ["/v2/iap/purchase/samsung", "Not implemented."],
      ["/v2/iap/subscription", "Not implemented."],
      ["/v2/iap/subscription/apple", "Method Not Allowed"],
      ["/v2/iap/subscription/google", "Method Not Allowed"],
    ];
    for (const [path, message] of expectations) {
      const response = await call(path, {
        authorization: bearer(world.token),
        body: { receipt: "synthetic-receipt" },
      });
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({
        code: UNIMPLEMENTED,
        message,
      });
    }
  });
});
