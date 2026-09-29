/**
 * Apple 传统 `verifyReceipt` 路径。
 *
 * 上游的行为分三步，这里逐步对齐（`iap/iap.go`）：
 *
 *   1. **先打生产端点**；拿到 `status == 21007`（收据来自沙盒）时**再用沙盒端点重试一次**。
 *      这不是错误路径，是 Apple 的既有约定。
 *   2. 非 200 → `IapValidationError`（带上状态码与原样响应体）。
 *   3. 从 `receipt.in_app[]` 与 `latest_receipt_info[]` 里挑出**非订阅**交易：
 *      `expires_date_ms` 非空的是订阅，跳过；同一 `transaction_id` 只算一次。
 *
 * 请求体逐字对齐上游：`{"receipt-data": ..., "exclude-old-transactions": true, "password": ...}`。
 *
 * 契约源（机器可读）：
 * 契约源: iap/iap.go::ValidateLegacyReceiptApple
 * 契约源: iap/iap.go::ValidateLegacyReceiptAppleWithUrl
 * 契约源: server/core_purchase.go::validateLegacyPurchaseReceiptApple
 *
 * REQ-0001-022
 */

import { invalidArgument, failedPrecondition } from "../../http/errors";
import type { AppleReceiptItem, AppleReceiptResponse, IapTransport } from "./types";
import {
  APPLE_RECEIPT_IS_FROM_TEST_SANDBOX,
  APPLE_RECEIPT_IS_VALID,
  APPLE_RECEIPT_URL_PRODUCTION,
  APPLE_RECEIPT_URL_SANDBOX,
  IapValidationError,
} from "./types";

export interface AppleReceiptValidation {
  readonly response: AppleReceiptResponse;
  readonly raw: string;
}

/**
 * 打一次 `verifyReceipt`。返回值是**解析后的响应 + 原样响应体**：
 * 原样体要进 `provider_response` 落库，所以不能只留解析结果。
 */
export async function postVerifyReceipt(
  transport: IapTransport,
  url: string,
  receipt: string,
  password: string,
): Promise<AppleReceiptValidation> {
  const result = await transport(url, {
    "receipt-data": receipt,
    "exclude-old-transactions": true,
    password,
  });
  if (result.status !== 200) {
    throw new IapValidationError("non-200 response from Apple service", result.status, result.body);
  }
  return { response: JSON.parse(result.body) as AppleReceiptResponse, raw: result.body };
}

/** 生产优先、沙盒重试的完整路径。 */
export async function validateLegacyReceiptApple(
  transport: IapTransport,
  receipt: string,
  password: string,
): Promise<AppleReceiptValidation> {
  const production = await postVerifyReceipt(transport, APPLE_RECEIPT_URL_PRODUCTION, receipt, password);
  if (production.response.status !== APPLE_RECEIPT_IS_FROM_TEST_SANDBOX) return production;
  return await postVerifyReceipt(transport, APPLE_RECEIPT_URL_SANDBOX, receipt, password);
}

/**
 * 把一次成功校验的响应转成"待落库的交易"。
 *
 * 三条规则都来自上游：跳过订阅（`expires_date_ms` 非空）、按 `transaction_id` 去重、
 * `purchase_date_ms` 必须是毫秒整数。另外上游把 `latest_receipt_info` 也当作交易来源
 * ——订阅续期会把新交易放在那里。
 */
export interface AppleTransaction {
  readonly productId: string;
  readonly transactionId: string;
  /** Unix **秒**（上游的落库精度；接口上是毫秒字符串）。 */
  readonly purchaseTimeSec: number;
}

export function transactionsOf(validation: AppleReceiptValidation): AppleTransaction[] {
  const { response } = validation;
  if (response.status !== APPLE_RECEIPT_IS_VALID) {
    // 重试提示优先：上游把"厂商暂时不可用"和"收据就是假的"分成两条对外错误。
    if (response.is_retryable === true) {
      throw failedPrecondition("Apple IAP verification is currently unavailable. Try again later.");
    }
    throw failedPrecondition(`Invalid Receipt. Status: ${response.status}`);
  }

  const items: readonly AppleReceiptItem[] = [
    ...(response.receipt?.in_app ?? []),
    ...(response.latest_receipt_info ?? []),
  ];
  const seen = new Set<string>();
  const transactions: AppleTransaction[] = [];
  for (const item of items) {
    if (item.expires_date_ms !== undefined && item.expires_date_ms !== "") continue;
    const transactionId = item.transaction_id ?? "";
    if (transactionId === "" || seen.has(transactionId)) continue;
    const milliseconds = Number(item.purchase_date_ms ?? "");
    if (!Number.isInteger(milliseconds)) {
      throw invalidArgument(`Invalid purchase_date_ms: ${item.purchase_date_ms ?? ""}`);
    }
    seen.add(transactionId);
    transactions.push({
      productId: item.product_id ?? "",
      transactionId,
      purchaseTimeSec: Math.floor(milliseconds / 1000),
    });
  }
  return transactions;
}
