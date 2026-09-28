import { create } from "@bufbuild/protobuf";
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import {
  EnvelopeSchema,
  MatchCreateSchema,
  type Envelope,
} from "../../../src/proto/realtime_pb";
import { handleEnvelope } from "../../../src/realtime/pipeline";
import { realtimeHooks } from "../../../src/realtime/pipeline-hooks";
import { resetRuntimeCache } from "../../../src/runtime/service";
import { errorOf, onlyReply, pipelineContext, recordingStatus } from "../../helpers/realtime";
import {
  authenticateDeviceOrFail,
  bearer,
  call,
  createTenant,
} from "../../helpers/tenants";
import { deployModules, runtimeWorld, walletOf } from "./harness";

/**
 * 前后置 hook（DoD 10）：HTTP 侧的 `registerBefore` / `registerAfter`，
 * 实时侧的 `registerRtBefore` / `registerRtAfter`。
 *
 * 上游那五条用例（`runtime_test.go`）分别只钉一件事，这里逐条对照：
 *
 * | 用例 | 上游断言 | 本文件 |
 * |---|---|---|
 * | ReqBeforeHook | acks 长度 1 | 放行 + 库里真的有那一行 |
 * | ReqBeforeHookDisallowed | 调用失败 | 404 + **库里没有新行**（反作弊条款） |
 * | ReqAfterHook | 钱包 == `{"gem": 10}` | 读 `users.wallet` 那一列 |
 * | RTBeforeHook | 钱包 == `{"gem": 20}` | 管线跑完 + 读库 |
 * | RTBeforeHookDisallow | 钱包 == `{}` | 拒绝帧 + `close` + 库里没有 |
 *
 * 另外补了两条上游没写但必须钉死的行为：before 里**抛异常**是 500（不是 404），
 * 以及 rt-after 只在**成功**的操作之后跑。
 *
 * 溯源: server/runtime_test.go::TestRuntimeReqBeforeHook,TestRuntimeReqBeforeHookDisallowed,TestRuntimeReqAfterHook
 * 溯源: server/runtime_test.go::TestRuntimeRTBeforeHook,TestRuntimeRTBeforeHookDisallow
 */

const HTTP_MODULE = `
export function InitModule(ctx, logger, nk, initializer) {
  initializer.registerBefore("WriteStorageObjects", async (ctx, logger, nk, payload) => {
    const first = payload && payload.objects && payload.objects[0];
    const key = first ? first.key : "";
    if (key === "deny") return null;
    if (key === "boom") throw new Error("hook blew up");
    return payload;
  });
  initializer.registerAfter("WriteStorageObjects", async (ctx, logger, nk, payload) => {
    await nk.walletUpdate(ctx.userId, { gem: 10 });
    return payload;
  });
}
`;

const RT_ALLOW_MODULE = `
export function InitModule(ctx, logger, nk, initializer) {
  initializer.registerRtBefore("MatchCreate", async (ctx, logger, nk, payload) => {
    await nk.walletUpdate(ctx.userId, { gem: 20 });
    return payload;
  });
}
`;

const RT_DENY_MODULE = `
export function InitModule(ctx, logger, nk, initializer) {
  initializer.registerRtBefore("MatchCreate", async (ctx, logger, nk) => null);
  initializer.registerRtAfter("MatchCreate", async (ctx, logger, nk, payload) => {
    await nk.walletUpdate(ctx.userId, { gem: 30 });
    return payload;
  });
}
`;

const BASE = "https://muster.test";

interface HttpWorld {
  readonly tenantId: string;
  readonly token: string;
  readonly userId: string;
}

/** HTTP hook 要一条**真会话**（`ctx.userId` 得是这次请求的那个用户），所以走认证端点。 */
async function httpWorld(): Promise<HttpWorld> {
  const tenantId = crypto.randomUUID().toUpperCase();
  const serverKey = `server-key-${tenantId}`;
  await createTenant(tenantId, serverKey, "runtime-hooks");
  const session = await authenticateDeviceOrFail(
    { id: tenantId, serverKey },
    `dev-${crypto.randomUUID()}`,
  );
  const response = await call("/v2/account", { authorization: bearer(session.token) });
  const account = (await response.json()) as { user: { id: string } };
  await deployModules(tenantId, { hooks: HTTP_MODULE });
  return { tenantId, token: session.token, userId: account.user.id };
}

function writeStorage(token: string, key: string): Promise<Response> {
  return SELF.fetch(`${BASE}/v2/storage`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: bearer(token) },
    body: JSON.stringify({
      objects: [{ collection: "collection", key, value: '{"key":"value"}' }],
    }),
  });
}

async function storedKeys(tenantId: string, collection: string): Promise<string[]> {
  const result = await env.DB.prepare(
    "SELECT key FROM storage_objects WHERE tenant_id = ?1 AND collection = ?2 ORDER BY key",
  )
    .bind(tenantId, collection)
    .all<{ key: string }>();
  return result.results.map((row) => row.key);
}

function matchCreateEnvelope(cid: string, name = ""): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: { case: "matchCreate", value: create(MatchCreateSchema, { name }) },
  });
}

afterEach(() => resetRuntimeCache());

describe("M8 hook: 请求侧", () => {
  it("test_req_before_hook_allows_and_the_write_lands", async () => {
    const world = await httpWorld();
    const response = await writeStorage(world.token, "key");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { acks: unknown[] };
    expect(body.acks).toHaveLength(1);
    expect(await storedKeys(world.tenantId, "collection")).toEqual(["key"]);
  });

  it("test_req_before_hook_returning_nil_is_404_and_leaves_no_row", async () => {
    const world = await httpWorld();
    const response = await writeStorage(world.token, "deny");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: 5,
      message: "Requested resource was not found.",
    });
    // 反作弊条款：拒绝必须同时表现为"HTTP 层被拒"与"库里没有新行"。
    expect(await storedKeys(world.tenantId, "collection")).toEqual([]);
  });

  it("test_req_before_hook_throwing_is_a_500_not_a_404", async () => {
    const world = await httpWorld();
    const response = await writeStorage(world.token, "boom");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: 2, message: "hook blew up" });
    expect(await storedKeys(world.tenantId, "collection")).toEqual([]);
  });

  it("test_req_after_hook_writes_the_wallet_of_the_caller", async () => {
    const world = await httpWorld();
    expect((await writeStorage(world.token, "key")).status).toBe(200);
    expect(await walletOf(world.tenantId, world.userId)).toEqual({ gem: 10 });
  });
});

describe("M8 hook: 实时侧", () => {
  it("test_rt_before_hook_runs_before_the_operation_and_lets_it_through", async () => {
    const world = await runtimeWorld();
    await deployModules(world.tenantId, { hooks: RT_ALLOW_MODULE });
    const context = realtimePipeline(world);

    const result = await handleEnvelope(context, matchCreateEnvelope("c1"));
    expect(result.close).toBe(false);
    expect(result.replies).toEqual([]);
    expect(await walletOf(world.tenantId, world.userId)).toEqual({ gem: 20 });
  });

  it("test_rt_before_hook_disallow_closes_the_connection_and_skips_rt_after", async () => {
    const world = await runtimeWorld();
    await deployModules(world.tenantId, { hooks: RT_DENY_MODULE });
    const context = realtimePipeline(world);

    const result = await handleEnvelope(context, matchCreateEnvelope("c1"));
    // 上游把"这个操作被模块禁用了"表达成"服务端不认识它"，并且**关掉连接**。
    expect(errorOf(onlyReply(result))).toEqual({
      code: 1, // Error_Code.UNRECOGNIZED_PAYLOAD
      message: "Requested resource was not found.",
    });
    expect(result.close).toBe(true);
    // 操作没跑 → after 不跑 → 钱包里一个字节都没有（上游断言 `{}`）。
    expect(await walletOf(world.tenantId, world.userId)).toEqual({});
  });

  it("test_a_rt_hook_that_throws_keeps_the_connection_open", async () => {
    const world = await runtimeWorld();
    await deployModules(world.tenantId, {
      hooks: `
export function InitModule(ctx, logger, nk, initializer) {
  initializer.registerRtBefore("MatchCreate", async () => {
    throw new Error("rt hook blew up");
  });
}
`,
    });
    const result = await handleEnvelope(realtimePipeline(world), matchCreateEnvelope("c1"));
    expect(errorOf(onlyReply(result))).toEqual({
      code: 7, // Error_Code.RUNTIME_FUNCTION_EXCEPTION
      message: "rt hook blew up",
    });
    // "hook 写错了"不该把玩家踢下线（上游那一处 `return true`）。
    expect(result.close).toBe(false);
  });
});

function realtimePipeline(world: { tenantId: string; userId: string; username: string }) {
  const caller = { userId: world.userId, username: world.username, sessionId: "hook-session" };
  return pipelineContext(world.tenantId, recordingStatus().service, {
    userId: world.userId,
    username: world.username,
    sessionId: caller.sessionId,
    runtime: realtimeHooks(env, world.tenantId, caller),
  });
}
