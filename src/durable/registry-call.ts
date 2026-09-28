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
import type { NotificationSnapshot } from "../realtime/notifications";

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

/**
 * 这批用户里，当前**在线**的那些。
 *
 * 上游把它叫 `FillOnlineUsers` / `FillOnlineFriends`：列表类端点返回前，把每个对象上的
 * `online` 布尔按在线状态填好。本项目等价的做法是问一次注册表——"谁在线"只有它知道。
 * 返回集合而不是逐个布尔，是因为调用方拿到的是一批用户，逐个问会变成 N 次跨 DO 调用。
 */
export async function registryOnline(
  env: Bindings,
  tenantId: string,
  userIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (userIds.length === 0) return new Set();
  const result = await registryCall<{ online: string[] }>(env, tenantId, "/online", { userIds });
  return new Set(result.online);
}

/**
 * 把若干条通知推给某个用户**当前在线的每条会话**。
 *
 * 上游在 `NotificationSend` 里做的是"按通知 stream 找 presence，再 SendToPresenceIDs"；
 * 本项目把这一步收进每租户一个的注册表 DO：只有它知道谁在线。调用方（通知域）
 * 已经先落库，所以这里的失败只意味着"某个客户端要等下次拉列表才看到"，不是数据丢失。
 */
export async function registryNotify(
  env: Bindings,
  tenantId: string,
  userId: string,
  notifications: readonly NotificationSnapshot[],
): Promise<void> {
  if (notifications.length === 0) return;
  await registryCall<{ ok: boolean }>(env, tenantId, "/notify", { userId, notifications });
}
