/**
 * 好友关系的三个写操作：加、删、拉黑。
 *
 * 三者共用同一套骨架，顺序不可颠倒（每一步都能在客户端上观察到）：
 *   1. 去重：上游把好友 id 放进 map，同一个 id 出现两次只处理一次；
 *   2. 逐条处理：某一条没写成不会让别的条目停摆（数据库错误除外）；
 *   3. 最后统一发通知：上游在事务提交后才收集并发送通知，本项目同样把
 *      "落库"与"推送"分开——推送失败不该回滚已经成立的关系。
 *
 * 通知文案是**契约**（客户端读 `code` 与 `subject` 做本地化），逐字来自上游：
 *   -2  `<username> wants to add you as a friend`
 *   -3  `<username> accepted your friend request`
 *   -9  `<username> removed you as a friend`
 * content 都是 `{"username": "<调用者>"}`，`sender_id` 是调用者，且**持久化**。
 *
 * 未实现的上游行为（登记在 ECN-0008）：`blockFriend` 末尾会 `tracker.UntrackByStream`
 * 把两人的私聊频道在线态一起清掉。本项目把频道在线态放在频道 DO 里，拉黑不主动踢人。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_friend.go::AddFriends
 * 契约源: server/core_friend.go::DeleteFriends
 * 契约源: server/core_friend.go::BlockFriends
 *
 * REQ-0001-011
 */

import { internal } from "../../http/errors";
import type { Bindings } from "../../env";
import { sendNotifications, type SendNotificationInput } from "../notifications/service";
import {
  acceptInvite,
  bumpEdgeCount,
  bumpEdgeCountsForNewPair,
  deleteEdges,
  deleteOppositeEdge,
  insertBlocked,
  insertInvitePair,
  markBlocked,
} from "./edges";
import { findEdgeState, nextPosition } from "./store";
import { FRIEND_STATE, NOTIFICATION_CODE } from "./types";

export interface FriendCaller {
  readonly id: string;
  readonly username: string;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function payload(username: string): string {
  return JSON.stringify({ username });
}

/**
 * 校验 `metadata` 能不能当作 JSON 存进去。
 *
 * 上游让 Postgres 报错（invalid jsonb），本项目在写库前先判一次，但**错误形状与
 * 上游一致**：`Internal "Error while trying to add friends."`。放在最前面还有一个好处：
 * metadata 非法时一条边都不会被写进去，与上游"整个事务回滚"的结果一致。
 */
function normalizeMetadata(metadata: string): string {
  if (metadata === "") return "{}";
  try {
    JSON.parse(metadata);
  } catch {
    throw internal("Error while trying to add friends.");
  }
  return metadata;
}

/**
 * 加好友（含"接受对方的邀请"这一支）。
 *
 * 只有**新建立**的关系才发通知：接受邀请发 -3，首次发出邀请发 -2；
 * 对方已经拉黑我、或关系早就存在时，库里改不到两行，一条通知都不发。
 */
export async function addFriends(
  env: Bindings,
  tenantId: string,
  caller: FriendCaller,
  targetIds: readonly string[],
  rawMetadata: string,
  now: number,
): Promise<void> {
  const metadata = normalizeMetadata(rawMetadata);
  const notifications: SendNotificationInput[] = [];

  for (const friendId of unique(targetIds)) {
    // 我已拉黑对方：不建边、不发通知（上游那句 "Ignoring previously blocked friend."）。
    if ((await findEdgeState(env.DB, tenantId, caller.id, friendId)) === FRIEND_STATE.blocked) {
      continue;
    }

    const accepted = await acceptInvite(env.DB, tenantId, caller.id, friendId, metadata, now);
    if ((accepted.meta.changes ?? 0) === 2) {
      notifications.push({
        userId: friendId,
        subject: `${caller.username} accepted your friend request`,
        content: payload(caller.username),
        code: NOTIFICATION_CODE.friendAccept,
        senderId: caller.id,
      });
      continue;
    }

    const position = await nextPosition(env.DB, tenantId);
    const results = await env.DB.batch([
      ...insertInvitePair(env.DB, tenantId, caller.id, friendId, position, metadata, now),
      bumpEdgeCountsForNewPair(env.DB, tenantId, caller.id, friendId, position, now),
    ]);
    // 计数那条是第三个语句：只有它改到两行，才说明"这次真的新建了关系"。
    if ((results[2]?.meta.changes ?? 0) !== 2) continue;
    notifications.push({
      userId: friendId,
      subject: `${caller.username} wants to add you as a friend`,
      content: payload(caller.username),
      code: NOTIFICATION_CODE.friendRequest,
      senderId: caller.id,
    });
  }

  await sendNotifications(env, tenantId, now, notifications);
}

/**
 * 删好友。
 *
 * 删到**两行**（双方都在）才算"解除一段关系"，此时才发 -9；只删到一行说明这原本是
 * "我单方面拉黑对方"，静默解封即可（上游同款分支）。删不动是无声的 0 行。
 */
export async function deleteFriends(
  env: Bindings,
  tenantId: string,
  caller: FriendCaller,
  targetIds: readonly string[],
  now: number,
): Promise<void> {
  const notifications: SendNotificationInput[] = [];

  for (const friendId of unique(targetIds)) {
    const result = await deleteEdges(env.DB, tenantId, caller.id, friendId);
    const changes = result.meta.changes ?? 0;
    if (changes === 0) continue;
    if (changes === 1) {
      await bumpEdgeCount(env.DB, tenantId, [caller.id], -1, now).run();
      continue;
    }
    if (changes !== 2) throw internal("Error while trying to delete friends.");
    await bumpEdgeCount(env.DB, tenantId, [caller.id, friendId], -1, now).run();
    notifications.push({
      userId: friendId,
      subject: `${caller.username} removed you as a friend`,
      content: payload(caller.username),
      code: NOTIFICATION_CODE.friendRemove,
      senderId: caller.id,
    });
  }

  await sendNotifications(env, tenantId, now, notifications);
}

/**
 * 拉黑。
 *
 * 三步：把自己的边变 BLOCKED（没有就补一条）→ 删掉对方朝向我的非拉黑边 →
 * 维护双方的 edge_count。目标账号不存在时上游一行不写、静默放过，本项目同款。
 */
export async function blockFriends(
  env: Bindings,
  tenantId: string,
  caller: FriendCaller,
  targetIds: readonly string[],
  now: number,
): Promise<void> {
  for (const friendId of unique(targetIds)) {
    const updated = await markBlocked(env.DB, tenantId, caller.id, friendId, now);
    if ((updated.meta.changes ?? 0) === 0) {
      const position = await nextPosition(env.DB, tenantId);
      const inserted = await insertBlocked(env.DB, tenantId, caller.id, friendId, position, now);
      // 一行都没写进去：目标账号不存在（上游同款静默返回）。
      if ((inserted.meta.changes ?? 0) === 0) continue;
      await bumpEdgeCount(env.DB, tenantId, [caller.id], 1, now).run();
    }

    const removed = await deleteOppositeEdge(env.DB, tenantId, caller.id, friendId);
    if ((removed.meta.changes ?? 0) === 1) {
      await bumpEdgeCount(env.DB, tenantId, [friendId], -1, now).run();
    }
  }
}
