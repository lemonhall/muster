/**
 * 实时消息的 hook 适配层：把 `service.runHook` 的判定折成管线要的形状。
 *
 * 上游 `pipeline.go::ProcessRequest` 在实时 before hook 上有**两档失败**，
 * 而且它们的"要不要关连接"是反的：
 *
 * - 模块**抛异常** → 回一帧 `RUNTIME_FUNCTION_EXCEPTION`，**保持连接**
 *   （"你的 hook 写错了"不该把玩家踢下线）；
 * - 模块**返回 nil** → 回一帧 `UNRECOGNIZED_PAYLOAD` + "Requested resource was not
 *   found."，并**关闭连接**——这正是上游把"这个操作被模块禁用了"表达成
 *   "服务端不认识它"的方式。
 *
 * after hook 只在**成功**的操作之后跑（`success == true`），失败的操作不触发它；
 * 它的返回值被上游丢掉，这里同样只记日志。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline.go::Pipeline.ProcessRequest
 *
 * REQ-0001-020
 */

import type { Bindings } from "../env";
import { runHook, type RuntimeCaller } from "../runtime/service";

/** 管线看到的判定结果：`close` 决定"这一帧之后要不要断开"。 */
export type RealtimeHookDecision =
  | { readonly kind: "proceed" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "disabled" };

export interface RealtimeHookService {
  before(op: string, payload: unknown): Promise<RealtimeHookDecision>;
  after(op: string, payload: unknown): Promise<void>;
}

/**
 * "永远放行"的实现：纯管线用例、以及"这个租户没有装模块"的场景都用它。
 * 它也让"hook 不存在时性能与行为都不变"这件事有一个显式的载体。
 */
export const ALLOW_ALL_HOOKS: RealtimeHookService = {
  before: () => Promise.resolve({ kind: "proceed" }),
  after: () => Promise.resolve(),
};

export function realtimeHooks(
  env: Bindings,
  tenantId: string,
  caller: RuntimeCaller,
): RealtimeHookService {
  return {
    async before(op, payload) {
      const decision = await runHook(env, tenantId, caller, "rtBefore", op, payload);
      if (!decision.registered) return { kind: "proceed" };
      if (decision.failed) return { kind: "failed", message: decision.message };
      return decision.allowed ? { kind: "proceed" } : { kind: "disabled" };
    },
    async after(op, payload) {
      try {
        const decision = await runHook(env, tenantId, caller, "rtAfter", op, payload);
        if (decision.registered && decision.failed) {
          console.error(`运行时 rt-after hook 执行失败：${op}`, decision.message);
        }
      } catch (error) {
        console.error(`运行时 rt-after hook 调用失败：${op}`, error);
      }
    },
  };
}
