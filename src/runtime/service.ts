/**
 * 宿主侧的运行时服务：装载缓存 + 三种调用（RPC、请求 hook、实时 hook）。
 *
 * 缓存的是**isolate 入口**，键是 `tenantId:revision`；外面那层"读模块清单算键"每次都
 * 走一次 D1（一条索引查询），因为"有人刚部署了新版本"必须在下一个请求就生效。
 *
 * 每次调用现造宿主壳（`host.ts`），所以能力对象里的租户与调用者永远是这一次的。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime.go::Runtime
 * 契约源: server/api_rpc.go::ApiServer.RpcFuncHttp
 * 契约源: server/pipeline.go::Pipeline.ProcessRequest
 *
 * REQ-0001-020
 */

import type { Bindings } from "../env";
import { EXECUTION_MODE, type CapabilityContext } from "./capability";
import { buildHostShell, moduleContext } from "./host";
import {
  listRuntimeModules,
  openRuntime,
  type HookOutcome,
  type RuntimeHandle,
} from "./loader";

export interface RuntimeCaller {
  readonly userId: string;
  readonly username: string;
  readonly sessionId: string;
}

export type RpcInvocation =
  | { readonly kind: "ok"; readonly payload: string }
  | { readonly kind: "missing" }
  | { readonly kind: "error"; readonly message: string };

/** hook 的判定结果：`allowed=false` 是**模块主动拒绝**，`failed` 是模块抛了异常。 */
export interface HookDecision {
  readonly registered: boolean;
  readonly allowed: boolean;
  readonly failed: boolean;
  readonly message: string;
}

const isolates = new Map<string, RuntimeHandle>();

export async function tenantRuntime(env: Bindings, tenantId: string): Promise<RuntimeHandle | null> {
  const listed = await listRuntimeModules(env, tenantId);
  if (listed === null) return null;
  const cached = isolates.get(listed.key);
  if (cached !== undefined) return cached;
  const handle = openRuntime(env, tenantId, listed.key, listed.modules);
  isolates.set(listed.key, handle);
  return handle;
}

/** 测试与排障用：把缓存清掉（下一次调用会重新读清单、必要时重新装载）。 */
export function resetRuntimeCache(): void {
  isolates.clear();
}

function capabilityOf(
  env: Bindings,
  tenantId: string,
  caller: RuntimeCaller,
  executionMode: string,
): CapabilityContext {
  return {
    env,
    tenantId,
    userId: caller.userId,
    username: caller.username,
    sessionId: caller.sessionId,
    executionMode,
  };
}

export async function callTenantRpc(
  env: Bindings,
  tenantId: string,
  caller: RuntimeCaller,
  name: string,
  payload: string,
): Promise<RpcInvocation> {
  const runtime = await tenantRuntime(env, tenantId);
  // 没有模块与"模块里没有这个 RPC"对客户端是同一件事：404 `RPC function not found`。
  if (runtime === null) return { kind: "missing" };
  const context = capabilityOf(env, tenantId, caller, EXECUTION_MODE.rpc);
  const outcome = await runtime.entry.callRpc(
    buildHostShell(context),
    moduleContext(context),
    name,
    payload,
  );
  if (outcome.ok) return { kind: "ok", payload: outcome.payload ?? "" };
  if (outcome.missing === true) return { kind: "missing" };
  return { kind: "error", message: outcome.message ?? "Error running RPC function." };
}

/**
 * 跑一次 hook。`kind` 取 `before` / `after` / `rtBefore` / `rtAfter`（与桥里的
 * 注册方法一一对应）；没有模块、没有注册该操作时返回"放行且未注册"。
 */
export async function runHook(
  env: Bindings,
  tenantId: string,
  caller: RuntimeCaller,
  kind: "before" | "after" | "rtBefore" | "rtAfter",
  op: string,
  payload: unknown,
): Promise<HookDecision> {
  const allowed: HookDecision = { registered: false, allowed: true, failed: false, message: "" };
  const runtime = await tenantRuntime(env, tenantId);
  if (runtime === null) return allowed;
  const mode = kind === "before" || kind === "rtBefore" ? EXECUTION_MODE.before : EXECUTION_MODE.after;
  const context = capabilityOf(env, tenantId, caller, mode);
  const outcome: HookOutcome = await runtime.entry.callHook(
    buildHostShell(context),
    moduleContext(context),
    kind,
    op,
    payload,
  );
  if (!outcome.registered) return allowed;
  return {
    registered: true,
    allowed: outcome.allowed === true,
    failed: outcome.failed === true,
    message: outcome.message ?? "",
  };
}
