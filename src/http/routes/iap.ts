/**
 * 内购校验端点。
 *
 * 本里程碑只把 **Apple 的传统 `verifyReceipt` 路径**做成真的（M9 的 REQ-0001-022
 * 验收对象），其余 provider 是**配置守卫**：上游 `server/api_purchase.go` 在这几条路
 * 上一律先查凭据，缺了就报 `FailedPrecondition "X IAP is not configured."`，这里逐字
 * 照搬那三句文案（Google / Huawei / Facebook Instant）。
 *
 * 两条刻意的取舍（都记在 ECN-0014）：
 *   - **Samsung 与订阅面（`/v2/iap/subscription/**`）不注册**，于是它们落到 router 的
 *     上游对账分支，对外是 `501 Not implemented.`——比编一个"未配置"更诚实：上游的
 *     Samsung 校验走的是公开订单接口，不需要凭据，"没凭据所以不可用"在那里说不通。
 *   - 厂商调用走**注入的传输层**（`src/domain/iap/transport.ts`）：生产是 JS
 *     `fetch`，测试换成假响应，因此测试与 E2E 都不会外呼 Apple（ECN-0014 偏差 5）。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_purchase.go::ValidatePurchaseApple
 * 契约源: server/api_purchase.go::ValidatePurchaseGoogle
 * 契约源: server/api_purchase.go::ValidatePurchaseHuawei
 * 契约源: server/api_purchase.go::ValidatePurchaseFacebookInstant
 *
 * REQ-0001-022
 */

import { validateApplePurchase } from "../../domain/iap/service";
import { iapTransport } from "../../domain/iap/transport";
import { validatePurchaseBody } from "../../wire/iap";
import { asObject, json, optionalBool, optionalString, parseBody } from "../body";
import { failedPrecondition } from "../errors";
import type { Router, UserContext } from "../router";

async function validateApple(context: UserContext): Promise<Response> {
  const body = asObject(await parseBody(context.request), "request body");
  const purchases = await validateApplePurchase(
    {
      db: context.env.DB,
      tenantId: context.tenantEnv.tenantId,
      userId: context.session.user.id,
      nowSec: context.tenantEnv.nowSec,
      transport: iapTransport(),
      appleSharedPassword: context.env.IAP_APPLE_SHARED_PASSWORD,
    },
    {
      receipt: optionalString(body, "receipt") ?? "",
      // `google.protobuf.BoolValue`：不传 = true（上游 `in.Persist == nil || in.Persist.Value`）。
      persist: optionalBool(body, "persist") ?? true,
    },
  );
  return json(validatePurchaseBody(purchases));
}

/** 配置守卫：凭据没配就是这个 provider 没开，文案逐字照搬上游。 */
function notConfigured(message: string): (context: UserContext) => Response {
  return () => {
    throw failedPrecondition(message);
  };
}

export function registerIapRoutes(router: Router): void {
  router.handleUser("POST", "/v2/iap/purchase/apple", validateApple);
  router.handleUser(
    "POST",
    "/v2/iap/purchase/google",
    notConfigured("Google IAP is not configured."),
  );
  router.handleUser(
    "POST",
    "/v2/iap/purchase/huawei",
    notConfigured("Huawei IAP is not configured."),
  );
  router.handleUser(
    "POST",
    "/v2/iap/purchase/facebookinstant",
    notConfigured("Facebook Instant IAP is not configured."),
  );
}
