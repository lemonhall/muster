import { Code, statusResponse } from "./grpc";

/**
 * 与上游 `status.Error(codes.X, msg)` 等价的一个错误。
 *
 * 全项目的失败路径都汇到这一个类型：抛出它 → 由 HTTP 层统一转成
 * `{"code":N,"message":"..."}` + 由 code 反推的 HTTP 状态码。
 * 不允许任何地方自己拼错误响应体。
 */
export class ApiError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }

  toResponse(): Response {
    return statusResponse(this.code, this.message);
  }
}

export const invalidArgument = (message: string): ApiError => new ApiError(Code.InvalidArgument, message);
export const unauthenticated = (message: string): ApiError => new ApiError(Code.Unauthenticated, message);
export const notFound = (message: string): ApiError => new ApiError(Code.NotFound, message);
export const alreadyExists = (message: string): ApiError => new ApiError(Code.AlreadyExists, message);
export const permissionDenied = (message: string): ApiError => new ApiError(Code.PermissionDenied, message);
export const internal = (message: string): ApiError => new ApiError(Code.Internal, message);
export const unimplemented = (message: string): ApiError => new ApiError(Code.Unimplemented, message);
