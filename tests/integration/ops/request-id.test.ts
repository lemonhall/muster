import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { socialWorld } from "../../helpers/social-world";
import { basicAuth, call, createTenant } from "../../helpers/tenants";

/**
 * M9 运维面：请求 ID 关联（DoD 8）。
 *
 * 反作弊点是"响应头与**日志行**同 id"：只看响应头非空，等于没有验证关联这件事。
 * 本项目的日志行落在 `request_log` 表（Worker 上没有可读的 stdout，见
 * `src/http/request-id.ts`），所以这里读的就是那一行。
 *
 * 另外两条边界：客户端给的 id 要**沿用**（跨服务的调用链才连得起来），自造的 id 要是
 * UUID 形状；以及没有解析出租户的请求（401）不写日志行——写不了，`tenant_id` 是必填。
 *
 * 契约源（机器可读）：
 * 契约源: server/console.go::LoggerWithTraceId
 *
 * REQ-0001-023
 */

interface LogRow {
  readonly request_id: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

async function logRowsOf(tenantId: string, requestId: string): Promise<LogRow[]> {
  const result = await env.DB.prepare(
    `SELECT request_id, method, path, status FROM request_log
     WHERE tenant_id = ?1 AND request_id = ?2 ORDER BY create_time, id`,
  )
    .bind(tenantId, requestId)
    .all<LogRow>();
  return result.results;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("M9 请求 ID: 响应头", () => {
  it("test_every_response_carries_an_id_even_when_nothing_matched", async () => {
    const health = await call("/healthcheck");
    const missing = await call("/v2/definitely-not-a-route");

    expect(health.status).toBe(200);
    expect(missing.status).toBe(404);
    // 自造的 id 是 UUID 形状（客户端没给就得能自己串起来）。
    expect(health.headers.get("x-request-id")).toMatch(UUID_SHAPE);
    expect(missing.headers.get("x-request-id")).toMatch(UUID_SHAPE);
    // 两次请求的 id 不同——它不是常量。
    expect(health.headers.get("x-request-id")).not.toBe(missing.headers.get("x-request-id"));
  });

  it("test_a_client_supplied_id_is_reused_verbatim", async () => {
    const response = await call("/healthcheck", { requestId: "trace-42.abc_1" });
    expect(response.headers.get("x-request-id")).toBe("trace-42.abc_1");
  });

  it("test_a_hostile_id_is_replaced_instead_of_echoed", async () => {
    // 带空白/控制字符的值不该被原样回灌到响应头与日志里。
    const response = await call("/healthcheck", { requestId: "bad id\n" });
    expect(response.headers.get("x-request-id")).toMatch(UUID_SHAPE);
  });
});

describe("M9 请求 ID: 日志关联", () => {
  it("test_the_log_row_shares_the_id_with_the_response_header", async () => {
    const world = await socialWorld(1);
    const requestId = "console-trace-0001";
    const response = await call("/v2/console/user", {
      authorization: basicAuth(world.serverKey),
      requestId,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(requestId);

    expect(await logRowsOf(world.tenant, requestId)).toEqual([
      { request_id: requestId, method: "GET", path: "/v2/console/user", status: 200 },
    ]);
  });

  it("test_a_failed_call_is_logged_with_its_status", async () => {
    const world = await socialWorld(1);
    const requestId = "console-trace-fail";
    const response = await call("/v2/console/user", {
      authorization: basicAuth(world.serverKey),
      requestId,
      body: { username: "nobody", email: "n@example.invalid", acl: {} },
    });
    expect(response.status).toBe(400);
    expect(await logRowsOf(world.tenant, requestId)).toEqual([
      { request_id: requestId, method: "POST", path: "/v2/console/user", status: 400 },
    ]);
  });

  it("test_the_log_is_scoped_to_the_tenant_that_served_the_request", async () => {
    const world = await socialWorld(1);
    const other = await createTenant("CCCCCCCC-0000-4000-8000-000000000003", "server-key-c", "ops-c");
    const requestId = "tenant-scoped-0001";
    await call("/v2/console/user", { authorization: basicAuth(world.serverKey), requestId });

    expect(await logRowsOf(world.tenant, requestId)).toHaveLength(1);
    expect(await logRowsOf(other.id, requestId)).toEqual([]);
  });

  it("test_an_unauthenticated_request_writes_no_log_row", async () => {
    const world = await socialWorld(1);
    const requestId = "no-server-key-0001";
    const response = await call("/v2/console/user", { requestId });
    expect(response.status).toBe(401);
    // 响应头照样有 id（对外可观测），但租户没解析出来 → 没有日志行。
    expect(response.headers.get("x-request-id")).toBe(requestId);
    expect(await logRowsOf(world.tenant, requestId)).toEqual([]);
  });
});
