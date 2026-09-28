/**
 * gRPC 状态码 → HTTP 状态码的映射，以及错误响应体的形状。
 *
 * 这是全部对外错误响应的唯一出口：上游 91 个 REST 操作的失败路径最终都汇聚到这里，
 * 所以映射表必须逐条照搬，而不是"差不多就行"。
 *
 * 契约源（机器可读）：
 * 契约源: vendor/github.com/grpc-ecosystem/grpc-gateway/v2/runtime/errors.go::HTTPStatusFromCode
 * 契约源: vendor/github.com/grpc-ecosystem/grpc-gateway/v2/runtime/errors.go::DefaultHTTPErrorHandler
 * 契约源: server/api.go::handleRoutingError
 */

/**
 * google.rpc.Code 的数值，与上游 proto 枚举一一对应。
 * 这里只声明本项目会产生的码；数值本身就是契约，不允许"顺手编号"。
 */
export const Code = {
  OK: 0,
  Canceled: 1,
  Unknown: 2,
  InvalidArgument: 3,
  DeadlineExceeded: 4,
  NotFound: 5,
  AlreadyExists: 6,
  PermissionDenied: 7,
  ResourceExhausted: 8,
  FailedPrecondition: 9,
  Aborted: 10,
  OutOfRange: 11,
  Unimplemented: 12,
  Internal: 13,
  Unavailable: 14,
  DataLoss: 15,
  Unauthenticated: 16,
} as const;

export type Code = (typeof Code)[keyof typeof Code];

/**
 * 与上游 `HTTPStatusFromCode` 逐条对齐的映射。
 *
 * 两个反直觉但必须照搬的点：
 * - FailedPrecondition 落到 400，不是 412（上游源码里有注释明确说明这是故意的）。
 * - Unimplemented 落到 501，这就是上游"方法不允许"最终返回 501 的原因。
 */
const HTTP_STATUS_BY_CODE: Readonly<Record<number, number>> = {
  [Code.OK]: 200,
  [Code.Canceled]: 499,
  [Code.Unknown]: 500,
  [Code.InvalidArgument]: 400,
  [Code.DeadlineExceeded]: 504,
  [Code.NotFound]: 404,
  [Code.AlreadyExists]: 409,
  [Code.PermissionDenied]: 403,
  [Code.ResourceExhausted]: 429,
  [Code.FailedPrecondition]: 400,
  [Code.Aborted]: 409,
  [Code.OutOfRange]: 400,
  [Code.Unimplemented]: 501,
  [Code.Internal]: 500,
  [Code.Unavailable]: 503,
  [Code.DataLoss]: 500,
  [Code.Unauthenticated]: 401,
};

/** 未知码按上游 default 分支处理：告警 + 500。 */
export function httpStatusFromCode(code: number): number {
  return HTTP_STATUS_BY_CODE[code] ?? 500;
}

/** google.rpc.Status 的 JSON 形状。空 details 在 protojson 下被整体省略。 */
export interface StatusBody {
  readonly code: number;
  readonly message: string;
}

/** 键序即序列化顺序（protojson 下为 code、message）；测试对精确字节串做了断言。 */
export function statusBody(code: number, message: string): StatusBody {
  return { code, message };
}

/** 上游所有 JSON 响应（成功与失败）统一使用这个 Content-Type，无 charset 后缀。 */
export const JSON_CONTENT_TYPE = "application/json";

/**
 * 401 响应上的 Bearer 挑战头。
 *
 * 上游 `wwwAuthenticateFixWriter` 在写 401 时补 `Bearer realm="nakama"`——它的用意是
 * 让浏览器/HTTP 客户端看到"这里要 Bearer 凭据"，而不是把 gRPC 的原始错误文案塞进头里
 * （上游测试 `TestWWWAuthenticateHeaderOnUnauthenticated` 就盯着这两点）。
 *
 * 唯一一处刻意不同：realm 用本项目的名字，**不复刻上游的产品名**（见 ECN-0003：
 * 仓库不得出现与上游产品沾边的对外标识）。头部形状、出现时机与"不放原始错误消息"
 * 这三条可观测语义都保留。
 *
 * 契约源: server/api_test.go::TestWWWAuthenticateHeaderOnUnauthenticated
 * 契约源: server/api.go::wwwAuthenticateFixWriter
 */
export const UNAUTHENTICATED_CHALLENGE = 'Bearer realm="muster"';

/**
 * 与上游 DefaultHTTPErrorHandler 等价的错误响应：
 * HTTP 状态码由 code 反推，响应体是 protojson 化的 google.rpc.Status。
 */
export function statusResponse(code: number, message: string): Response {
  const status = httpStatusFromCode(code);
  const headers: Record<string, string> = { "content-type": JSON_CONTENT_TYPE };
  if (status === 401) {
    headers["www-authenticate"] = UNAUTHENTICATED_CHALLENGE;
  }
  return new Response(JSON.stringify(statusBody(code, message)), {
    status,
    headers,
  });
}
