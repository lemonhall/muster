/**
 * 群组事件的**两条广播通道**：群组频道的系统消息，与频道里的 presence 摘除。
 *
 * 上游把这两件事都写在自己的内存 tracker / 主库 `message` 表里（`core_group.go`
 * 的 `router.SendToStream` 与 `streamManager.UserLeave`）。本项目二者都归**频道 DO**
 * 所有，所以这里只做"算频道 id + 调用 + 失败只记日志"这一层。
 *
 * 为什么失败只记日志：这两件事都是**已经成立的数据库变更的附属效果**
 * （成员已经加进去了、已经退群了）。上游同样是 fire-and-forget——`SendToStream`
 * 不返回错误，`UserLeave` 的失败只 `Warn`。让"群里少了一条加入提示"把整个加入操作
 * 变成失败，是比它更糟的结果。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_group.go::JoinGroup
 * 契约源: server/core_group.go::LeaveGroup
 * 契约源: server/core_group.go::BanGroupUsers
 *
 * REQ-0001-012
 */

import type { Bindings } from "../../env";
import { channelEvictAll, channelEvictUser, channelSystemMessage } from "../../durable/channel-call";
import { STREAM_MODE, streamToChannelId } from "../../realtime/channel-ids";

/** 群组频道的频道 id：`3.<group_id>..`（与 `channelIdToStream` 的规范形一致）。 */
export function groupChannelId(groupId: string): string {
  return streamToChannelId({
    mode: STREAM_MODE.group,
    subject: groupId,
    subcontext: "",
    label: "",
  });
}

/**
 * 往群频道写一条系统消息（`code` 取 `CHANNEL_MESSAGE_TYPE` 里 3..9 的群事件）。
 *
 * `senderId`/`username` 是**当事人**：加入的人、退群的人、被踢的人——上游如此，
 * 所以客户端看到的"XX 加入了群组"里的 XX 就是这条消息的 username。
 */
export async function postGroupEvent(
  env: Bindings,
  tenantId: string,
  groupId: string,
  event: { readonly code: number; readonly userId: string; readonly username: string },
): Promise<void> {
  try {
    await channelSystemMessage(env, tenantId, groupChannelId(groupId), {
      code: event.code,
      senderId: event.userId,
      username: event.username,
    });
  } catch (error) {
    console.error("群组频道系统消息写入失败", error);
  }
}

/** 把某人从他的群频道里摘出去（退群、被踢、被封禁之后）。 */
export async function evictGroupPresence(
  env: Bindings,
  tenantId: string,
  groupId: string,
  userId: string,
): Promise<void> {
  try {
    await channelEvictUser(env, tenantId, groupChannelId(groupId), userId);
  } catch (error) {
    console.error("群组频道成员摘除失败", error);
  }
}

/** 群被删除：把留在群频道里的所有人的 presence 一起摘掉。 */
export async function evictGroupChannel(
  env: Bindings,
  tenantId: string,
  groupId: string,
): Promise<void> {
  try {
    await channelEvictAll(env, tenantId, groupChannelId(groupId));
  } catch (error) {
    console.error("群组频道清空失败", error);
  }
}
