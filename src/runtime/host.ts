/**
 * 每次调用递给隔离区的那个"宿主壳"：`{ logger, nk }`。
 *
 * 两个都是**普通对象**（`nk` 见 `capability.ts`，`logger` 见 `js-logger.ts`），
 * 因为 workerd 的 RPC 只对普通对象里的函数做 stub 化——类实例会 `DataCloneError`。
 * 隔离区里 `host.logger.info("...")` 与 `host.nk.md5Hash("...")` 于是都会回到这里执行。
 *
 * 宿主壳**每次调用现造**：它闭在"这一次调用的租户与调用者"上。不缓存它，是因为
 * isolate 是跨请求复用的，而身份不是。
 *
 * 隔离区那份 logger 用的是上游 JS 运行时的形状（`createJsLogger`：无 `runtime` 字段、
 * 派生从基础字段重算），不是宿主侧的 Go 形状——模块看到的是"JS 运行时给自己的
 * logger"，这一点与上游一致。
 *
 * REQ-0001-020
 */

import type { CapabilityContext } from "./capability";
import { buildNk } from "./capability";
import { consoleSink } from "./log";
import { createJsLogger } from "./js-logger";

export interface RuntimeHostShell {
  readonly logger: unknown;
  readonly nk: Record<string, unknown>;
}

/** 模块收到的 `ctx`：上游 `RuntimeExecutionMode` + 当前调用者，没有别的字段（ECN-0012 偏差 12）。 */
export function moduleContext(context: CapabilityContext): Record<string, unknown> {
  return {
    userId: context.userId,
    username: context.username,
    sessionId: context.sessionId,
    executionMode: context.executionMode,
    matchId: context.matchId ?? "",
    vars: {},
    env: {},
  };
}

export function buildHostShell(context: CapabilityContext): RuntimeHostShell {
  return {
    logger: createJsLogger(consoleSink),
    nk: buildNk(context),
  };
}
