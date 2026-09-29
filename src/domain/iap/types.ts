/**
 * 内购校验的公共类型与常量。
 *
 * 数值与字符串**逐条抄自上游** `iap/iap.go` 与 `api/api.proto`——它们都是对外可观测的
 * 契约（客户端按 `store` / `environment` 的数值分支，Apple 按 `status` 判断收据是否有效）：
 *
 *   - `AppleReceiptIsValid = 0` / `AppleReceiptIsFromTestSandbox = 21007`
 *   - 两个 `verifyReceipt` 端点（生产与沙盒）
 *   - `api.StoreProvider` 与 `api.StoreEnvironment` 的枚举值
 *
 * 契约源（机器可读）：
 * 契约源: iap/iap.go::ValidateLegacyReceiptApple
 * 契约源: vendor/github.com/heroiclabs/nakama-common/api/api.proto::StoreProvider
 * 契约源: vendor/github.com/heroiclabs/nakama-common/api/api.proto::StoreEnvironment
 *
 * REQ-0001-022
 */

/** Apple 收到的收据有效。 */
export const APPLE_RECEIPT_IS_VALID = 0;
/** 收据来自测试沙盒，应该拿去沙盒端点重试（不是错误）。 */
export const APPLE_RECEIPT_IS_FROM_TEST_SANDBOX = 21007;

export const APPLE_RECEIPT_URL_PRODUCTION = "https://buy.itunes.apple.com/verifyReceipt";
export const APPLE_RECEIPT_URL_SANDBOX = "https://sandbox.itunes.apple.com/verifyReceipt";

/** 上游 `iap.AppleSandboxEnvironment`：响应里的 `environment` 字段取值。 */
export const APPLE_ENVIRONMENT_SANDBOX = "Sandbox";

/** `api.StoreProvider`。 */
export const StoreProvider = {
  APPLE_APP_STORE: 0,
  GOOGLE_PLAY_STORE: 1,
  HUAWEI_APP_GALLERY: 2,
  FACEBOOK_INSTANT_STORE: 3,
  SAMSUNG_GALAXY_STORE: 4,
} as const;

/** `api.StoreEnvironment`。 */
export const StoreEnvironment = {
  UNKNOWN: 0,
  SANDBOX: 1,
  PRODUCTION: 2,
} as const;

/** 一次厂商 HTTP 调用的结果：状态码 + **原样**响应体（原样体要进 `provider_response`）。 */
export interface IapHttpResponse {
  readonly status: number;
  readonly body: string;
}

/** 厂商调用面。默认实现是真 `fetch`，测试注入假响应（ECN-0014 偏差 5）。 */
export type IapTransport = (url: string, payload: unknown) => Promise<IapHttpResponse>;

/**
 * 厂商返回了非 200。
 *
 * 上游把这种错误**原样**抛给 gRPC（于是 code 是 `Unknown` = HTTP 500），消息形如
 * `non-200 response from Apple service, status=502, payload=...`。这里保持同形。
 */
export class IapValidationError extends Error {
  readonly statusCode: number;
  readonly payload: string;

  constructor(reason: string, statusCode: number, payload: string) {
    super(`${reason}, status=${statusCode}, payload=${payload}`);
    this.name = "IapValidationError";
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

/** Apple `receipt.in_app[]` / `latest_receipt_info[]` 里的条目（只取本项目要用的字段）。 */
export interface AppleReceiptItem {
  readonly transaction_id?: string;
  readonly product_id?: string;
  readonly purchase_date_ms?: string;
  /** 非空表示这是一条订阅交易：购买面要跳过它（订阅走另一个端点）。 */
  readonly expires_date_ms?: string;
}

/** Apple `verifyReceipt` 的响应（只取本项目要用的字段）。 */
export interface AppleReceiptResponse {
  readonly status: number;
  readonly is_retryable?: boolean;
  readonly environment?: string;
  readonly receipt?: { readonly in_app?: readonly AppleReceiptItem[] };
  readonly latest_receipt_info?: readonly AppleReceiptItem[];
}
