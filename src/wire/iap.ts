/**
 * `/v2/iap/purchase/{provider}` 的线格式（protojson + `UseProtoNames` + `UseEnumNumbers`）。
 *
 * 三条容易写错的规则，都是客户端 API 的 marshaler 行为（`server/api.go` 的
 * `JSONPb{UseProtoNames: true, UseEnumNumbers: true}`，**没有** `EmitUnpopulated`）：
 *
 *   1. 零值整体省略。于是 Apple 的 `store`（`APPLE_APP_STORE = 0`）**不会出现**在响应里，
 *      客户端反序列化后拿到的仍然是 0；`seen_before: false` 同理不出现，
 *      只有"这条收据我见过"时才发 `true`。
 *   2. `purchase_time` / `create_time` / `update_time` 是 Timestamp，发 RFC3339 字符串。
 *   3. `persist=false` 时上游不落库、也就没有 create/update：这两个字段整体缺席，
 *      而不是发一个零时间。
 *
 * 契约源（机器可读）：
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/iap/purchase/apple
 * 契约源: vendor/github.com/heroiclabs/nakama-common/api/api.proto::ValidatedPurchase
 *
 * REQ-0001-022
 */

import type { ValidatedPurchase } from "../domain/iap/service";
import { formatTimestamp } from "./identity";

export function validatedPurchaseBody(row: ValidatedPurchase): Record<string, unknown> {
  return {
    ...(row.userId === "" ? {} : { user_id: row.userId }),
    ...(row.productId === "" ? {} : { product_id: row.productId }),
    ...(row.transactionId === "" ? {} : { transaction_id: row.transactionId }),
    ...(row.store === 0 ? {} : { store: row.store }),
    ...(row.purchaseTimeSec === 0 ? {} : { purchase_time: formatTimestamp(row.purchaseTimeSec) }),
    ...(row.createTimeSec === 0 ? {} : { create_time: formatTimestamp(row.createTimeSec) }),
    ...(row.updateTimeSec === 0 ? {} : { update_time: formatTimestamp(row.updateTimeSec) }),
    ...(row.providerResponse === "" ? {} : { provider_response: row.providerResponse }),
    ...(row.environment === 0 ? {} : { environment: row.environment }),
    ...(row.seenBefore ? { seen_before: true } : {}),
  };
}

/** `api.ValidatePurchaseResponse`：`validated_purchases` 为空时整个字段缺席。 */
export function validatePurchaseBody(purchases: readonly ValidatedPurchase[]): Record<string, unknown> {
  return purchases.length === 0
    ? {}
    : { validated_purchases: purchases.map(validatedPurchaseBody) };
}
