/**
 * 请求（HTTP）hook 的**判定语义**，只此一处。
 *
 * 逐条对齐上游 `api_storage.go::WriteStorageObjects`：
 *
 * - **before 抛异常** → `status.Error(code, msg)`（本项目的 code 取 `Unknown`，
 *   因为上游 JS 运行时返回的就是它）；
 * - **before 返回 nil** → `NotFound` + "Requested resource was not found."
 *   ——"模块主动禁用这个操作"在上游表达成 404，不是 403；
 * - **after 出错只是记日志**：上游 `traceApiAfter(...)` 的返回值被丢掉了，
 *   所以"after 失败"不会把一次已经落库的写变成失败。照抄这个方向，
 *   而不是"顺手做得更严谨一点"——那会改变客户端看到的状态码。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_storage.go::ApiServer.WriteStorageObjects
 * 契约源: server/api.go::ApiServer.beforeHook
 *
 * REQ-0001-020
 */

import type { Bindings } from "../env";
import { ApiError, notFound } from "../http/errors";
import { Code } from "../http/grpc";
import { runHook, type RuntimeCaller } from "./service";

/** 上游没有给请求 hook 传会话 id（那是实时消息才有的东西），如实留空。 */
export function requestCaller(userId: string, username: string): RuntimeCaller {
  return { userId, username, sessionId: "" };
}

export async function runRequestBefore(
  env: Bindings,
  tenantId: string,
  caller: RuntimeCaller,
  op: string,
  payload: unknown,
): Promise<void> {
  const decision = await runHook(env, tenantId, caller, "before", op, payload);
  if (!decision.registered) return;
  if (decision.failed) throw new ApiError(Code.Unknown, decision.message);
  if (!decision.allowed) throw notFound("Requested resource was not found.");
}

/** after 是"已经成功了，顺带通知一下"：失败只记日志，不改客户端看到的结果。 */
export async function runRequestAfter(
  env: Bindings,
  tenantId: string,
  caller: RuntimeCaller,
  op: string,
  payload: unknown,
): Promise<void> {
  try {
    const decision = await runHook(env, tenantId, caller, "after", op, payload);
    if (decision.registered && decision.failed) {
      console.error(`运行时 after hook 执行失败：${op}`, decision.message);
    }
  } catch (error) {
    console.error(`运行时 after hook 调用失败：${op}`, error);
  }
}
