/**
 * 内购校验的服务层：把"HTTP 入参 + 厂商响应"翻译成"要回给客户端的已校验交易"。
 *
 * 顺序是有意为之，且**逐条对齐上游 `server/api_purchase.go` + `core_purchase.go`**：
 *
 *   1. 凭据守卫先行：Apple 没配 shared secret 就 `FailedPrecondition
 *      "Apple IAP is not configured."`——注意这是**在解析收据之前**，与上游同序。
 *   2. 收据不能为空（`Receipt cannot be empty.`，`InvalidArgument`）。
 *   3. 出网校验（注入的传输层）→ 非 200 抛 `IapValidationError`（映射成 500，与上游
 *      把裸错误交给 gRPC 的结果同形）。
 *   4. `status != 0` → 可重试的报 `Unavailable`，否则 `FailedPrecondition
 *      "Invalid Receipt. Status: N"`。
 *   5. 全是订阅（有 `expires_date_ms`）时 `FailedPrecondition "Subscription Receipt.
 *      Use the appropriate function instead."`。
 *   6. `persist`（缺省 true）为真才落库；返回体带 `create_time` / `update_time` /
 *      `seen_before`，为假时这三样都没有——与上游 `persist=false` 分支一致。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_purchase.go::ValidatePurchaseApple
 * 契约源: server/core_purchase.go::validateLegacyPurchaseReceiptApple
 *
 * REQ-0001-022
 */

import { ApiError, failedPrecondition, invalidArgument } from "../../http/errors";
import { Code } from "../../http/grpc";
import { transactionsOf, validateLegacyReceiptApple } from "./apple";
import { upsertPurchases, type NewPurchaseRow } from "./store";
import type { IapTransport } from "./types";
import {
  APPLE_ENVIRONMENT_SANDBOX,
  IapValidationError,
  StoreEnvironment,
  StoreProvider,
} from "./types";

export interface ValidatedPurchase {
  readonly userId: string;
  readonly productId: string;
  readonly transactionId: string;
  readonly store: number;
  readonly purchaseTimeSec: number;
  readonly environment: number;
  readonly providerResponse: string;
  /** `persist = false` 时是 0（响应里不出现这两个时间）。 */
  readonly createTimeSec: number;
  readonly updateTimeSec: number;
  readonly seenBefore: boolean;
}

export interface IapContext {
  readonly db: D1Database;
  readonly tenantId: string;
  readonly userId: string;
  readonly nowSec: number;
  readonly transport: IapTransport;
  /** Apple shared secret；未配置即"这个 provider 没开"。 */
  readonly appleSharedPassword: string | undefined;
}

export interface ApplePurchaseInput {
  readonly receipt: string;
  /** 缺省 true（上游 `in.Persist == nil || in.Persist.Value`）。 */
  readonly persist: boolean;
}

export async function validateApplePurchase(
  context: IapContext,
  input: ApplePurchaseInput,
): Promise<ValidatedPurchase[]> {
  const password = context.appleSharedPassword ?? "";
  if (password === "") throw failedPrecondition("Apple IAP is not configured.");
  // 空收据在出网之前就被拒：既省一次往返，也让"客户端漏传字段"与"收据是假的"
  // 分成两条不同的错误（DoD 10 要求这两条各自独立可判）。
  if (input.receipt === "") throw invalidArgument("Receipt cannot be empty.");

  const validation = await verifyReceipt(context, input.receipt, password);
  const transactions = transactionsOf(validation);
  if (transactions.length === 0) {
    throw failedPrecondition("Subscription Receipt. Use the appropriate function instead.");
  }

  const environment =
    validation.response.environment === APPLE_ENVIRONMENT_SANDBOX
      ? StoreEnvironment.SANDBOX
      : StoreEnvironment.PRODUCTION;

  const rows: NewPurchaseRow[] = transactions.map((transaction) => ({
    userId: context.userId,
    productId: transaction.productId,
    transactionId: transaction.transactionId,
    purchaseTimeSec: transaction.purchaseTimeSec,
    environment,
    rawResponse: validation.raw,
  }));

  if (!input.persist) {
    // 不落库：上游在这个分支里直接回显解析结果，没有 create/update/seen_before。
    return rows.map((row) => ({
      userId: row.userId,
      productId: row.productId,
      transactionId: row.transactionId,
      store: StoreProvider.APPLE_APP_STORE,
      purchaseTimeSec: row.purchaseTimeSec,
      environment: row.environment,
      providerResponse: row.rawResponse,
      createTimeSec: 0,
      updateTimeSec: 0,
      seenBefore: false,
    }));
  }

  const stored = await upsertPurchases(
    context.db,
    context.tenantId,
    StoreProvider.APPLE_APP_STORE,
    rows,
    context.nowSec,
  );
  return stored.map((row) => ({
    userId: row.userId,
    productId: row.productId,
    transactionId: row.transactionId,
    store: row.store,
    purchaseTimeSec: row.purchaseTimeSec,
    environment: row.environment,
    providerResponse: row.rawResponse,
    createTimeSec: row.createTimeSec,
    updateTimeSec: row.updateTimeSec,
    seenBefore: row.seenBefore,
  }));
}

/**
 * 出网校验 + 错误映射。
 *
 * 厂商非 200 时上游把 `*iap.ValidationError` 直接交给 gRPC，于是对外是
 * `code = 2 (Unknown)` + HTTP 500 + 那条含状态码与响应体的消息。这里显式地把它折成
 * 同一个形状，而不是让它变成 router 兜底的通用 500——通用 500 会把"是 Apple 那边
 * 502 了"这条最有用的信息吃掉。
 */
async function verifyReceipt(
  context: IapContext,
  receipt: string,
  password: string,
): Promise<Awaited<ReturnType<typeof validateLegacyReceiptApple>>> {
  try {
    return await validateLegacyReceiptApple(context.transport, receipt, password);
  } catch (error) {
    if (error instanceof IapValidationError) throw new ApiError(Code.Unknown, error.message);
    throw error;
  }
}
