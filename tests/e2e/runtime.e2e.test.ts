import { describe, expect, it } from "vitest";

import { e2eTenant } from "./global-setup";
import { baseUrl, basic, authenticateDevice, freshDeviceId } from "./http-helpers";

/**
 * M8 E2E：租户运行时 RPC，走真实 `wrangler dev --local` 进程上的真 HTTP。
 *
 * 与 `tests/integration/runtime/rpc.test.ts` 的分工：那边在测试池里用 `SELF.fetch`
 * 直接打处理函数；这里是真的监听在端口上的进程，于是"模块真的能在这个运行时里被
 * Worker Loader 装起来"这件事才有网络上的证据——隔离区装载、能力桥的 RPC、
 * 以及模块里那次 `nk` 存储往返，全都发生在被部署的进程里。
 *
 * 模块本身在 dev server 起来之前就写进本地 D1（见 `runtime-fixture.ts` 与
 * `global-setup.ts`），所以这里只负责"调它"。
 *
 * 目标进程是本机 workerd，不连任何 Cloudflare 账号资源。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_rpc.go::ApiServer.RpcFuncHttp
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/rpc/{id}
 *
 * REQ-0001-020
 */

interface RpcOptions {
  readonly method?: string;
  readonly authorization?: string;
  /** **原样**请求体：RPC 协议上 payload 本身是一个 JSON 字符串，这里不做二次编码。 */
  readonly body?: string;
  readonly contentType?: string;
}

function rpcCall(path: string, options: RpcOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.contentType !== undefined) headers["content-type"] = options.contentType;
  if (options.authorization !== undefined) headers["authorization"] = options.authorization;
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? "POST",
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

describe("M8 E2E: 运行时 RPC", () => {
  it("test_http_key_channel_returns_the_payload_from_the_deployed_module", { timeout: 120_000 }, async () => {
    // 上游那条断言：请求体是一个 **JSON 字符串**，回包是 `{"payload":<那串>}`。
    const response = await rpcCall(`/v2/rpc/helloworld?http_key=${e2eTenant.serverKey}`, {
      body: '""',
      contentType: "application/json",
    });
    expect(response.status, `RPC 失败：${response.status} ${await response.clone().text()}`).toBe(200);
    expect(await response.text()).toBe('{"payload":"Hello World"}');

    // 注册名大小写不敏感：路径里给全大写也通（上游 `strings.ToLower(maybeID)`）。
    const shouty = await rpcCall(`/v2/rpc/HelloWorld?http_key=${e2eTenant.serverKey}`, {
      body: '"x"',
      contentType: "application/json",
    });
    expect(shouty.status).toBe(200);
    expect(await shouty.text()).toBe('{"payload":"Hello World"}');
  });

  it("test_a_user_token_call_can_round_trip_through_nk_storage", { timeout: 120_000 }, async () => {
    const { session } = await authenticateDevice(e2eTenant, freshDeviceId("e2e-runtime"));
    const response = await rpcCall("/v2/rpc/echo", {
      authorization: `Bearer ${session.token}`,
      body: JSON.stringify("hello-runtime"),
      contentType: "application/json",
    });
    expect(response.status, `RPC 失败：${response.status} ${await response.clone().text()}`).toBe(200);
    const body = (await response.json()) as { payload: string };
    // `nk.storageWrite` → `nk.storageRead` 的往返真的落在了这个进程的 D1 上。
    expect(JSON.parse(body.payload)).toEqual({
      executionMode: "rpc",
      hasUser: true,
      rows: 1,
      value: { payload: "hello-runtime" },
    });
  });

  it("test_module_state_survives_across_two_real_requests", { timeout: 120_000 }, async () => {
    // 这一条是"跨请求复用 isolate"的**现场证据**：两个真 HTTP 请求分别打过来（各自是
    // 一次独立的请求上下文），模块级计数器必须从 1 走到 2，而 `InitModule` 只跑一次。
    // 装上 Loader stub 之前用缓存句柄跨请求复用，正是这一条会红（workerd 拒绝
    // 跨请求用 I/O 对象；ECN-0012 偏差 15）。
    const first = await rpcCall(`/v2/rpc/counter?http_key=${e2eTenant.serverKey}`, {
      body: '""',
      contentType: "application/json",
    });
    expect(first.status, `RPC 失败：${first.status} ${await first.clone().text()}`).toBe(200);
    expect(JSON.parse(((await first.json()) as { payload: string }).payload)).toEqual({
      count: 1,
      init: 1,
    });

    const second = await rpcCall(`/v2/rpc/counter?http_key=${e2eTenant.serverKey}`, {
      body: '""',
      contentType: "application/json",
    });
    expect(second.status).toBe(200);
    expect(JSON.parse(((await second.json()) as { payload: string }).payload)).toEqual({
      count: 2,
      init: 1,
    });
  });

  it("test_unknown_rpc_and_missing_credentials_keep_the_upstream_error_bodies", { timeout: 60_000 }, async () => {
    const unknown = await rpcCall(`/v2/rpc/nope?http_key=${e2eTenant.serverKey}`, {
      body: '""',
      contentType: "application/json",
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: "RPC function not found",
      message: "RPC function not found",
      code: 5,
    });

    const anonymous = await rpcCall("/v2/rpc/helloworld", { body: '""' });
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()) as { message: string }).toMatchObject({
      message: "Auth token or HTTP key required",
    });

    // Basic 那条通道与 `?http_key=` 等价（上游把 Basic 也当 server key 看）。
    const viaBasic = await rpcCall("/v2/rpc/helloworld", {
      authorization: basic(e2eTenant.serverKey),
      body: '""',
      contentType: "application/json",
    });
    expect(viaBasic.status).toBe(200);
    expect(await viaBasic.text()).toBe('{"payload":"Hello World"}');
  });
});
