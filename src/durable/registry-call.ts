/**
 * 分片 → 注册表的调用封装。
 *
 * DO 之间只能通过 `fetch` 说话，所以这里把"路径 + JSON 进 / JSON 出"这件事
 * 收成一个小函数，调用方不必知道 URL 长什么样。失败一律抛出——在线状态宁可不更新，
 * 也不能假装成功（否则关注者会以为某人在线/离线，而事实相反）。
 *
 * REQ-0001-009
 */

import type { Bindings } from "../env";
import type { PresenceSnapshot } from "../realtime/presence";

export async function registryCall<T>(
  env: Bindings,
  tenantId: string,
  path: string,
  body: unknown,
): Promise<T> {
  const stub = env.SESSION_REGISTRY.get(env.SESSION_REGISTRY.idFromName(tenantId));
  const response = await stub.fetch(`https://registry${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`会话注册表调用失败：${path} -> ${response.status}`);
  }
  return (await response.json()) as T;
}

export interface ConnectBody {
  readonly sessionId: string;
  readonly userId: string;
  readonly username: string;
  readonly wantsStatus: boolean;
}

export async function registryFollow(
  env: Bindings,
  tenantId: string,
  sessionId: string,
  userIds: readonly string[],
): Promise<readonly PresenceSnapshot[]> {
  const result = await registryCall<{ presences: PresenceSnapshot[] }>(
    env,
    tenantId,
    "/follow",
    { sessionId, userIds },
  );
  return result.presences;
}
