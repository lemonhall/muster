import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { resetRuntimeCache } from "../../../src/runtime/service";
import { authenticateDeviceOrFail, basicAuth, bearer, call, createTenant } from "../../helpers/tenants";
import { deployModules } from "./harness";

/**
 * RPC 注册与调用（DoD 9）：模块注册 → 真实 HTTP → 客户端拿到 payload。
 *
 * 上游两条用例（`TestRuntimeRegisterRPCWithPayload` / `...EndToEnd`）钉的是同一件事的
 * 前后两截：注册名能被查到、以及**线上那条** `POST /v2/rpc/helloworld?http_key=...`
 * 回 `{"payload":"Hello World"}`。这里合成一条完整链路，并补齐上游没写但客户端会撞到的
 * 三件事：两条鉴权通道、`?unwrap` 的裸响应、以及错误体形状。
 *
 * 溯源: server/runtime_test.go::TestRuntimeRegisterRPCWithPayload,TestRuntimeRegisterRPCWithPayloadEndToEnd
 */

const BASE = "https://muster.test";

const MODULE = `
export function InitModule(ctx, logger, nk, initializer) {
  initializer.registerRpc("HelloWorld", async (ctx, logger, nk, payload) => {
    return payload;
  });
  initializer.registerRpc("describe", async (ctx, logger, nk, payload) => {
    return JSON.stringify({
      mode: ctx.executionMode,
      user: ctx.userId === "",
      logger: typeof logger.info,
      nk: typeof nk.md5Hash,
      payload,
    });
  });
}
`;

interface RpcWorld {
  readonly tenantId: string;
  readonly serverKey: string;
  readonly token: string;
  readonly userId: string;
}

async function rpcWorld(): Promise<RpcWorld> {
  const tenantId = crypto.randomUUID().toUpperCase();
  const serverKey = `server-key-${tenantId}`;
  await createTenant(tenantId, serverKey, "runtime-rpc");
  const session = await authenticateDeviceOrFail(
    { id: tenantId, serverKey },
    `dev-${crypto.randomUUID()}`,
  );
  const response = await call("/v2/account", { authorization: bearer(session.token) });
  const account = (await response.json()) as { user: { id: string } };
  await deployModules(tenantId, { game: MODULE });
  return { tenantId, serverKey, token: session.token, userId: account.user.id };
}

function rpcCall(
  path: string,
  options: { readonly authorization?: string; readonly body?: string; readonly method?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.authorization !== undefined) headers["authorization"] = options.authorization;
  return SELF.fetch(`${BASE}${path}`, {
    method: options.method ?? "POST",
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

afterEach(() => resetRuntimeCache());

describe("M8 RPC: 注册与调用", () => {
  it("test_register_rpc_with_payload_over_the_http_key_channel", async () => {
    const world = await rpcWorld();
    // 上游那条断言：请求体是一个 **JSON 字符串**，回包是 `{"payload":<那串>}`。
    const payload = '"Hello World"';
    const response = await rpcCall(`/v2/rpc/helloworld?http_key=${world.serverKey}`, {
      body: payload,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`{"payload":${payload}}`);
  });

  it("test_register_rpc_with_a_user_token_and_the_ctx_of_that_session", async () => {
    const world = await rpcWorld();
    const response = await rpcCall("/v2/rpc/describe", {
      authorization: bearer(world.token),
      body: '"ping"',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { payload: string };
    expect(JSON.parse(body.payload)).toEqual({
      mode: "rpc",
      // 用户令牌那条通道带着会话身份；`http_key` 那条没有（上游同样如此）。
      user: false,
      logger: "function",
      nk: "function",
      payload: "ping",
    });
  });

  it("test_http_key_channel_has_no_session_identity", async () => {
    const world = await rpcWorld();
    const response = await rpcCall(`/v2/rpc/describe?http_key=${world.serverKey}`, {
      body: '""',
    });
    const body = (await response.json()) as { payload: string };
    expect((JSON.parse(body.payload) as { user: boolean }).user).toBe(true);
  });

  it("test_the_registered_name_is_case_insensitive", async () => {
    const world = await rpcWorld();
    // 注册的是 `HelloWorld`，路径里写全小写（上游 `strings.ToLower(maybeID)`）。
    const response = await rpcCall(`/v2/rpc/helloworld?http_key=${world.serverKey}`, {
      body: '"x"',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"payload":"x"}');
  });

  it("test_unwrap_returns_the_payload_itself", async () => {
    const world = await rpcWorld();
    // 带 `unwrap` 时两端都不做 JSON 包装：请求体原样当 payload 递进去，回包就是
    // 模块的返回值。这正是上游那对 flag 的语义（`unwrap` = "别替我编解码"）。
    const response = await rpcCall(`/v2/rpc/helloworld?http_key=${world.serverKey}&unwrap`, {
      body: "raw",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("raw");
  });

  it("test_get_without_a_body_is_allowed", async () => {
    const world = await rpcWorld();
    const response = await rpcCall(`/v2/rpc/helloworld?http_key=${world.serverKey}`, {
      method: "GET",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"payload":""}');
  });
});

describe("M8 RPC: 鉴权与错误", () => {
  it("test_no_credentials_is_rejected", async () => {
    const world = await rpcWorld();
    const response = await rpcCall("/v2/rpc/helloworld", { body: '""' });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Auth token or HTTP key required",
      message: "Auth token or HTTP key required",
      code: 16,
    });
    expect(world.serverKey.startsWith("server-key-")).toBe(true);
  });

  it("test_a_wrong_http_key_is_rejected_and_basic_auth_is_the_same_channel", async () => {
    const world = await rpcWorld();
    const wrong = await rpcCall("/v2/rpc/helloworld?http_key=nope", { body: '""' });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()) as { message: string }).toMatchObject({
      message: "HTTP key invalid",
    });

    const basic = await rpcCall("/v2/rpc/helloworld", {
      authorization: basicAuth(world.serverKey),
      body: '"via-basic"',
    });
    expect(await basic.text()).toBe('{"payload":"via-basic"}');
  });

  it("test_an_unknown_rpc_is_a_404_with_the_upstream_message", async () => {
    const world = await rpcWorld();
    const response = await rpcCall(`/v2/rpc/nope?http_key=${world.serverKey}`, { body: '""' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "RPC function not found",
      message: "RPC function not found",
      code: 5,
    });
  });

  it("test_a_non_string_json_body_is_rejected", async () => {
    const world = await rpcWorld();
    const response = await rpcCall(`/v2/rpc/helloworld?http_key=${world.serverKey}`, {
      body: '{"a":1}',
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as { message: string }).toMatchObject({
      message: "json: cannot unmarshal object into Go value of type string",
    });
  });

  it("test_a_missing_tenant_has_no_runtime_so_the_rpc_is_404", async () => {
    // 一个没部署过任何模块的租户：`missing` 与"模块里没这个 RPC"对外是同一件事。
    const tenantId = crypto.randomUUID().toUpperCase();
    const serverKey = `server-key-${tenantId}`;
    await createTenant(tenantId, serverKey, "runtime-rpc-empty");
    const response = await rpcCall(`/v2/rpc/helloworld?http_key=${serverKey}`, { body: '""' });
    expect(response.status).toBe(404);
    expect((await response.json()) as { message: string }).toMatchObject({
      message: "RPC function not found",
    });
  });
});
