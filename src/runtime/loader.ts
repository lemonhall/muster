/**
 * 把租户模块装载进一个**独立 isolate**。
 *
 * 装载键是 `tenantId:sha256(name@revision…)`（见 `modules.ts::revisionKey`）。键不变
 * 就复用一个 isolate，键变了（有人部署了新版本）就换一个新的。这条性质同时买到两件事：
 *
 * - DoD 4 的"`InitModule` 只执行一次"：模块级状态活在 isolate 里，复用它，状态就在；
 * - 部署的即时性：不需要重启平台，下一次请求就会用新 revision 的 isolate。
 *
 * **分两半做**：`buildRuntimeDefinition` 造的是纯数据（装载键 + 模块映射），可以
 * 跨请求缓存；`mountRuntime` 造的是句柄（Loader stub + 入口 stub），**每次调用现造**。
 *
 * 为什么句柄不能跨请求缓存：Loader 返回的 stub 是一个 I/O 对象，它绑在**造它的那次
 * 请求**上。缓存它、下一个请求再用，真 workerd 会拒绝：
 *
 * ```
 * Error: Cannot perform I/O on behalf of a different request. I/O objects (such as
 * streams, request/response bodies, and others) created in the context of one request
 * handler cannot be accessed from a different request's handler.
 *   (I/O type: SubrequestChannel)
 * ```
 *
 * 这条限制不影响 isolate 复用：复用是 Loader 按 key 做的，不是我们在宿主侧靠缓存
 * stub 做的。键不变 → 还是那个 isolate → 模块级状态仍然在（E2E 里用"跨两个真 HTTP
 * 请求的计数器"钉住这件事）。记在 ECN-0012 偏差 15。
 *
 * `globalOutbound: null` 是**出口策略**：租户模块不能自己 `fetch`。需要出网的能力
 * 将来必须由宿主代发（ECN-0012 的出口策略段），这样"哪个模块在往哪发请求"是平台
 * 可审计、可限流、可一键关停的。
 *
 * 装载失败**不降级**：宁可让请求 500，也不静默地当成"这个租户没有模块"——后者会让
 * 一次部署事故表现成"我的 RPC 忽然没了"，排查方向完全错。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime.go::Runtime
 *
 * REQ-0001-020
 */

import type { Bindings } from "../env";
import { HOST_MODULE, buildModuleMap } from "./bridge";
import { listLatestModules, revisionKey, type TenantModule } from "./modules";

/** 装载进去的 isolate 用的兼容日期：跟着本仓库的 runtime 形状走，不跟部署时间走。 */
const COMPATIBILITY_DATE = "2026-09-28";

export interface Registrations {
  readonly rpc: readonly string[];
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly rtBefore: readonly string[];
  readonly rtAfter: readonly string[];
}

export interface RpcOutcome {
  readonly ok: boolean;
  readonly missing?: boolean;
  readonly payload?: string | null;
  readonly message?: string;
}

export interface HookOutcome {
  readonly registered: boolean;
  readonly allowed?: boolean;
  readonly failed?: boolean;
  readonly payload?: string | null;
  readonly message?: string;
}

/** 被装载 Worker 的入口类。方法名与 `bridge.ts` 里的 `RuntimeModuleHost` 一一对应。 */
export interface RuntimeEntrypoint {
  setup(host: unknown, ctx: unknown): Promise<Registrations>;
  describe(): Promise<Registrations>;
  callRpc(host: unknown, ctx: unknown, name: string, payload: string): Promise<RpcOutcome>;
  callHook(
    host: unknown,
    ctx: unknown,
    kind: string,
    op: string,
    payload: unknown,
  ): Promise<HookOutcome>;
}

export interface RuntimeHandle {
  /** 装载键：日志、缓存、排障都用它。 */
  readonly key: string;
  readonly tenantId: string;
  readonly names: readonly string[];
  readonly modules: readonly TenantModule[];
  readonly entry: RuntimeEntrypoint;
  /**
   * Loader 返回的那个 stub 本身。
   *
   * 必须持有它：入口 stub 的生命周期挂在父 stub 上，只留入口会让父 stub 被回收，
   * 之后再用入口就是 `RPC stub used after being disposed.`（本地实测）。
   * 它是"这条装载记录的所有权凭据"，所以留在句柄里而不是某个临时变量里。
   * 句柄是**一次调用**的寿命（见文件头：stub 绑在请求上），所以它只能活在一次请求里。
   */
  readonly loader: unknown;
}

/**
 * 可以跨请求缓存的那一半：装载键 + 拼好的模块映射。全是**纯数据**，
 * 没有 stream、没有 stub、没有请求上下文。
 */
export interface RuntimeDefinition {
  readonly key: string;
  readonly tenantId: string;
  readonly names: readonly string[];
  readonly modules: readonly TenantModule[];
  /** Worker Loader 要的 `modules` 映射（宿主桥 + 每个租户模块）。 */
  readonly files: Readonly<Record<string, string>>;
}

/**
 * 读模块清单并算出装载键。清单为空返回 `null` —— 调用方据此走"没有运行时"的快速
 * 路径，而不是白装载一个空 isolate。
 */
export async function listRuntimeModules(
  env: Bindings,
  tenantId: string,
): Promise<{ readonly modules: readonly TenantModule[]; readonly key: string } | null> {
  const modules = await listLatestModules(env.DB, tenantId);
  if (modules.length === 0) return null;
  return { modules, key: await revisionKey(tenantId, modules) };
}

/** 按装载键取 isolate 的入口。同一个键重复调用拿到的是同一个 isolate。 */
export function mountRuntime(env: Bindings, definition: RuntimeDefinition): RuntimeHandle {
  const stub = env.LOADER.get(definition.key, () => ({
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: [],
    mainModule: HOST_MODULE,
    modules: { ...definition.files },
    globalOutbound: null,
  }));
  return {
    key: definition.key,
    tenantId: definition.tenantId,
    names: definition.names,
    modules: definition.modules,
    loader: stub,
    entry: stub.getEntrypoint("RuntimeModuleHost") as unknown as RuntimeEntrypoint,
  };
}

/** 造那一半可以跨请求缓存的东西：装载键与模块映射，纯字符串处理。 */
export function buildRuntimeDefinition(
  tenantId: string,
  key: string,
  modules: readonly TenantModule[],
): RuntimeDefinition {
  const built = buildModuleMap(modules);
  return { key, tenantId, names: built.names, modules, files: built.modules };
}

/** 一站式：读清单 + 装载。给测试与"一次性调用"的场景用。 */
export async function loadRuntime(env: Bindings, tenantId: string): Promise<RuntimeHandle | null> {
  const listed = await listRuntimeModules(env, tenantId);
  if (listed === null) return null;
  return mountRuntime(env, buildRuntimeDefinition(tenantId, listed.key, listed.modules));
}
