import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  authenticateDeviceOrFail,
  bearer,
  call,
  createBothTenants,
  TENANT_A_REF,
} from "../../helpers/tenants";

/**
 * M3 契约测试：`/ws` 握手。
 *
 * 期望值逐条来自上游 `server/socket_ws.go` 的 `NewSocketWsAcceptor`：
 * - `format` 只认 `""` / `json` / `protobuf`，其余 400 `Invalid format parameter`；
 * - 有 Authorization 头但不是 `Bearer ` 前缀 → 401 `Missing or invalid token`；
 * - 没有 Authorization 头就退到查询参数 `token`；两者都拿不到 → 401 同一条消息；
 * - 令牌解析失败、会话已被吊销、账号不存在/被封禁 → 401 同一条消息。
 *
 * 这些失败响应是 Go `http.Error` 的形状（`text/plain; charset=utf-8` + 末尾换行），
 * 不是 gRPC 的 JSON 错误体——因为握手发生在协议外层，还没进 RPC 通道。
 *
 * 契约源（机器可读）：
 * 契约源: server/socket_ws.go::NewSocketWsAcceptor
 * 契约源: server/socket_ws.go::extractClientAddressFromRequest
 *
 * REQ-0001-008
 */

const WS_URL = "https://muster.test/ws";

function dial(options: { readonly authorization?: string; readonly query?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { upgrade: "websocket" };
  if (options.authorization !== undefined) headers["authorization"] = options.authorization;
  return SELF.fetch(`${WS_URL}${options.query ?? ""}`, { headers });
}

/** Go 的 `http.Error` 形状：纯文本 + 末尾换行。 */
async function expectHttpError(response: Response, status: number, body: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(await response.text()).toBe(`${body}\n`);
}

describe("M3 契约: /ws 握手", () => {
  it("test_ws_without_any_token_is_rejected", async () => {
    await createBothTenants();
    await expectHttpError(await dial(), 401, "Missing or invalid token");
  });

  it("test_ws_with_an_unusable_authorization_header_is_rejected", async () => {
    await createBothTenants();
    await expectHttpError(await dial({ authorization: "Token abc" }), 401, "Missing or invalid token");
  });

  it("test_ws_rejects_an_invalid_format_parameter", async () => {
    await createBothTenants();
    await expectHttpError(await dial({ query: "?format=xml" }), 400, "Invalid format parameter");
  });

  it("test_ws_rejects_a_token_that_was_signed_for_another_tenant", async () => {
    await createBothTenants();
    const session = await authenticateDeviceOrFail(TENANT_A_REF, `ws-cross-${crypto.randomUUID()}`);
    // 令牌本身是合法的，但签名密钥属于租户 A；把它的 gid 换成 B 会验签失败。
    const forged = `${session.token.split(".").slice(0, 2).join(".")}.AAAA`;
    await expectHttpError(await dial({ authorization: bearer(forged) }), 401, "Missing or invalid token");
  });

  it("test_ws_upgrades_with_a_bearer_token", async () => {
    await createBothTenants();
    const session = await authenticateDeviceOrFail(TENANT_A_REF, `ws-accept-${crypto.randomUUID()}`);

    const response = await dial({ authorization: bearer(session.token) });

    expect(response.status).toBe(101);
    expect(response.webSocket).not.toBeNull();
    response.webSocket?.accept();
    response.webSocket?.close();
  });

  it("test_ws_upgrades_with_a_query_token", async () => {
    await createBothTenants();
    const session = await authenticateDeviceOrFail(TENANT_A_REF, `ws-query-${crypto.randomUUID()}`);

    const response = await dial({ query: `?token=${encodeURIComponent(session.token)}` });

    expect(response.status).toBe(101);
    expect(response.webSocket).not.toBeNull();
    response.webSocket?.accept();
    response.webSocket?.close();
  });

  it("test_websocket_rejects_session_after_logout", async () => {
    // 溯源: server/socket_ws_test.go::TestWebSocketRejectsSessionAfterLogout
    await createBothTenants();
    const session = await authenticateDeviceOrFail(TENANT_A_REF, `ws-logout-${crypto.randomUUID()}`);

    // 登出前握手成功。
    const before = await dial({ authorization: bearer(session.token) });
    expect(before.status).toBe(101);
    before.webSocket?.accept();
    before.webSocket?.close();

    const logout = await call("/v2/session/logout", {
      authorization: bearer(session.token),
      body: { token: session.token },
    });
    expect(logout.status).toBe(200);

    // 登出后：Bearer 与查询参数两条路都必须被拒。
    await expectHttpError(await dial({ authorization: bearer(session.token) }), 401, "Missing or invalid token");
    await expectHttpError(
      await dial({ query: `?token=${encodeURIComponent(session.token)}` }),
      401,
      "Missing or invalid token",
    );
  });
});
