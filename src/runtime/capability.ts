/**
 * 把工具面、数据面、群组面拼成隔离区看到的那个 `nk`。
 *
 * 这个对象**每次调用现造**，不放进模块级变量、不跨请求复用：
 * `nk` 的每个函数都闭在"这一次调用的租户与调用者"上，而 RPC 的另一端是
 * 上一个请求留下的 isolate——把能力对象留在那里，就是让上一个请求的身份
 * 泄漏给下一个请求。造对象很便宜（几十个闭包），复用它的代价却不可逆。
 *
 * 隔离区里拿到的是一个 stub：每个函数调用都会回到这里执行，所以"租户是谁"
 * 由宿主闭包决定，模块参数改不了（DoD 5）。
 *
 * REQ-0001-020
 */

import type { Bindings } from "../env";
import { buildNkCompetitive } from "./capability-competitive";
import { buildNkData } from "./capability-data";
import { buildNkGroups } from "./capability-groups";
import { buildNkLedger } from "./capability-ledger";
import { buildNkRecords } from "./capability-records";
import { buildNkTools } from "./capability-tools";

export interface CapabilityContext {
  readonly env: Bindings;
  readonly tenantId: string;
  readonly userId: string;
  readonly username: string;
  readonly sessionId: string;
  /** 上游 `ctx.ExecutionMode`：`rpc` / `before` / `after` / `lua` / `go`。 */
  readonly executionMode: string;
  readonly matchId?: string;
}

/** `nk` 是"模块能碰到的全部平台能力"。返回普通对象，不是类实例。 */
export function buildNk(context: CapabilityContext): Record<string, unknown> {
  const data = { env: context.env, tenantId: context.tenantId };
  return {
    ...buildNkTools(),
    ...buildNkData(data),
    ...buildNkGroups(data),
    ...buildNkCompetitive(data),
    ...buildNkRecords(data),
    ...buildNkLedger(data),
  };
}

/**
 * 上游 `RuntimeExecutionMode` → 模块看到的字符串。
 *
 * 名字逐字取自上游枚举（`rpc` / `before` / `after` / `lua` / `go`），因为模块会
 * 按它分支（例如"只在真实请求里写审计"）。本项目没有 `lua`/`go` 两种模式。
 */
export const EXECUTION_MODE = {
  rpc: "rpc",
  before: "before",
  after: "after",
} as const;
