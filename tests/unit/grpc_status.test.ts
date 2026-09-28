import { describe, expect, it } from "vitest";

import { Code, httpStatusFromCode, statusBody } from "../../src/http/grpc";

/**
 * 单元契约：gRPC 状态码 → HTTP 状态码的映射，以及错误响应体形状。
 *
 * 这两件事是上游 REST 面所有错误响应的公共底座：91 个操作的失败路径最终都经过它，
 * 所以先把映射表钉死，后面每个业务错误码的对齐才有统一参照。
 *
 * 契约源（机器可读）：
 * 契约源: vendor/github.com/grpc-ecosystem/grpc-gateway/v2/runtime/errors.go::HTTPStatusFromCode
 * 契约源: vendor/github.com/grpc-ecosystem/grpc-gateway/v2/runtime/errors.go::DefaultHTTPErrorHandler
 *
 * REQ-0001-002
 */
describe("M0 契约: gRPC 状态码到 HTTP 状态码的映射", () => {
  const table: Array<[name: string, code: number, http: number]> = [
    ["OK", Code.OK, 200],
    ["Canceled", Code.Canceled, 499],
    ["Unknown", Code.Unknown, 500],
    ["InvalidArgument", Code.InvalidArgument, 400],
    ["DeadlineExceeded", Code.DeadlineExceeded, 504],
    ["NotFound", Code.NotFound, 404],
    ["AlreadyExists", Code.AlreadyExists, 409],
    ["PermissionDenied", Code.PermissionDenied, 403],
    ["ResourceExhausted", Code.ResourceExhausted, 429],
    ["FailedPrecondition", Code.FailedPrecondition, 400],
    ["Aborted", Code.Aborted, 409],
    ["OutOfRange", Code.OutOfRange, 400],
    ["Unimplemented", Code.Unimplemented, 501],
    ["Internal", Code.Internal, 500],
    ["Unavailable", Code.Unavailable, 503],
    ["DataLoss", Code.DataLoss, 500],
    ["Unauthenticated", Code.Unauthenticated, 401],
  ];

  for (const [name, code, http] of table) {
    it(`test_http_status_from_code_${name}`, () => {
      expect(httpStatusFromCode(code)).toBe(http);
    });
  }

  it("test_error_body_matches_protojson_status_shape", () => {
    // google.rpc.Status 的 protojson 形状：空 details 被省略，键序为 code、message。
    expect(statusBody(Code.NotFound, "Not Found")).toEqual({
      code: 5,
      message: "Not Found",
    });
    expect(JSON.stringify(statusBody(Code.NotFound, "Not Found"))).toBe(
      '{"code":5,"message":"Not Found"}',
    );
  });
});
