import { describe, expect, it } from "vitest";

/**
 * E2E：走真实 HTTP 通道（真实 wrangler dev 进程），不 import 任何处理函数。
 *
 * 默认指向 global-setup 拉起的本地 Worker；设 `MUSTER_E2E_TARGET` 可指向别处
 * （预发环境，或反证用：指向一个没人监听的端口时这一组必须整片变红）。
 *
 * 契约源（机器可读）：
 * 契约源: server/api.go::grpcGatewayRouter
 * 契约源: server/api.go::handleRoutingError
 * 契约源: vendor/github.com/grpc-ecosystem/grpc-gateway/v2/runtime/errors.go::HTTPStatusFromCode
 *
 * REQ-0001-001, REQ-0001-002
 */
const baseUrl = process.env.MUSTER_E2E_TARGET ?? `http://127.0.0.1:${process.env.MUSTER_E2E_PORT ?? "8788"}`;

describe("M0 E2E: 真实 HTTP 通道", () => {
  it("test_get_root_returns_200_over_real_http", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
  });

  it("test_get_healthcheck_returns_200_with_empty_json_object_over_real_http", async () => {
    const res = await fetch(`${baseUrl}/healthcheck`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).toBe("{}");
  });

  it("test_get_unknown_path_returns_404_over_real_http", async () => {
    const res = await fetch(`${baseUrl}/no-such-endpoint`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 5, message: "Not Found" });
  });

  it("test_method_mismatch_follows_upstream_501_semantics_over_real_http", async () => {
    // 上游把 405 映射成 codes.Unimplemented，再由 code 反推 HTTP 状态 → 501。
    // 这条断言的作用是把"跟上游一样地反直觉"钉住，防止后来者顺手改成 405。
    const res = await fetch(`${baseUrl}/healthcheck`, { method: "POST" });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ code: 12, message: "Method Not Allowed" });
  });
});
