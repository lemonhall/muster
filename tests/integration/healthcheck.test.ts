import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * M0 契约测试：与上游参考实现的对外可观测行为对齐。
 *
 * 行为契约来自上游实现，不是猜测：
 * - 根路径返回 200：上游 grpc-gateway 路由表里对 "/" 注册了仅 GET 的处理函数，直接写 200。
 * - /healthcheck 由 RPC Healthcheck 提供，返回 google.protobuf.Empty，
 *   用 protojson 序列化后即为 "{}"；对应 apigrpc.proto 中
 *   `option (google.api.http).get = "/healthcheck"`。
 * - 未知路径的 404 由上游 handleRoutingError 生成：
 *   status.Error(codes.NotFound, http.StatusText(404)) → code=5, message="Not Found"。
 *
 * 契约源（机器可读，供 docs/conformance/coverage-matrix.md 溯源）：
 * 契约源: server/api.go::grpcGatewayRouter
 * 契约源: server/api.go::handleRoutingError
 * 契约源: apigrpc/apigrpc.swagger.json::/healthcheck
 * 契约源: vendor/github.com/grpc-ecosystem/grpc-gateway/v2/runtime/errors.go::DefaultHTTPErrorHandler
 *
 * REQ-0001-001, REQ-0001-002
 */
describe("M0 契约: 根路径与健康检查", () => {
  it("test_get_root_returns_200", async () => {
    const res = await SELF.fetch("https://muster.test/");
    expect(res.status).toBe(200);
  });

  it("test_get_healthcheck_returns_200_with_empty_json_object", async () => {
    const res = await SELF.fetch("https://muster.test/healthcheck");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    // Empty 消息在 protojson 下就是 {}，不是 {"success":true} 之类的自造形状
    expect(await res.text()).toBe("{}");
  });

  it("test_get_unknown_path_returns_404_with_grpc_status_body", async () => {
    const res = await SELF.fetch("https://muster.test/no-such-endpoint");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { code?: number; message?: string };
    expect(body.code).toBe(5); // codes.NotFound
    expect(body.message).toBe("Not Found");
  });
});
