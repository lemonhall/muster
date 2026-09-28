/**
 * 频道里**由群组域遥控的三件事**：写一条系统消息、摘掉一个人、清空所有人。
 *
 * 为什么从 `channel-core.ts` 挪出来：这个文件是"频道语义"的一半，而这三件事
 * 的调用者不是客户端——是群组域（建群/退群/踢人/封禁/删群）。它们对内核的依赖
 * 恰好收敛成一个 `ChannelGroupContext`（频道 id、模板、成员表、消息表、扇出），
 * 所以可以整块搬走，让 `channel-core.ts` 回到"会话进来的那条路径"上。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_group.go::JoinGroup
 * 契约源: server/core_group.go::LeaveGroup
 * 契约源: server/core_group.go::DeleteGroup
 * 契约源: server/tracker.go::LocalTracker.UntrackAll
 *
 * REQ-0001-012
 */

import type { ChannelMessageWire, ChannelTemplate } from "../realtime/channel";
import { channelMessageEnvelope, channelPresenceEventEnvelope } from "../realtime/channel";
import type { ChannelFanout } from "./channel-fanout";
import type { ChannelMembers } from "./channel-members";
import type { ChannelMessages } from "./channel-messages";
import { presenceOfRow } from "./channel-presence";

/** 这三件事需要的内核部件；由 `ChannelCore` 在调用时按需给出。 */
export interface ChannelGroupContext {
  readonly channelId: string;
  readonly template: ChannelTemplate;
  readonly members: ChannelMembers;
  readonly messages: ChannelMessages;
  readonly fanout: ChannelFanout;
}

/**
 * 系统消息的入参：`code` 是上游 `ChannelMessageType` 里 3..9 的群事件，
 * `senderId`/`username` 是**当事人**（退群的人、被踢的人……），与上游一致。
 */
export interface GroupSystemMessageInput {
  readonly code: number;
  readonly senderId: string;
  readonly username: string;
}

/**
 * 频道里的**系统消息**：不是客户端发的，而是群组域写下来的事件
 * （上游 `core_group.go` 七条路径各插一条 `message`，`code` 3..9，`content` 恒为 `{}`）。
 *
 * 与 `send` 的两处刻意差别：
 * 1. 没有"必须在频道里"的前置——事件的作者是**服务端**，不是这个频道里的某条会话；
 * 2. 广播不排除任何人（上游是 `router.SendToStream`，它会发给流上的全部 presence）。
 *
 * 时间戳同样走 `nextTimestampMs`，所以群事件在历史里的先后与它们在库里落地的先后一致。
 */
export async function postSystemMessage(
  ctx: ChannelGroupContext,
  input: GroupSystemMessageInput,
): Promise<void> {
  const at = ctx.messages.nextTimestampMs(Date.now());
  const message: ChannelMessageWire = {
    messageId: crypto.randomUUID(),
    code: input.code,
    senderId: input.senderId,
    username: input.username,
    content: "{}",
    createTimeMs: at,
    updateTimeMs: at,
    persistent: true,
  };
  ctx.messages.insert({
    id: message.messageId,
    code: message.code,
    sender_id: message.senderId,
    username: message.username,
    content: message.content,
    create_time_ms: message.createTimeMs,
    update_time_ms: message.updateTimeMs,
  });
  await ctx.fanout.send("", channelMessageEnvelope(ctx.channelId, ctx.template, message));
}

/**
 * 把某个用户的**全部会话**从这个频道摘掉，并补上 leave 事件。
 *
 * 上游在"退群 / 被踢 / 被封禁"三条路径的末尾都会调 `streamManager.UserLeave`：
 * 人已经不在群里了，却还挂在群频道上继续收消息，是上游明确要避免的状态。
 * 返回摘除后剩下的成员数，供调用方（DO 外壳）决定还要不要保留巡检闹钟。
 */
export async function evictUserPresence(
  ctx: ChannelGroupContext,
  userId: string,
): Promise<number> {
  const dropped = ctx.members
    .dropSessions(ctx.members.sessionsOfUser(userId))
    .filter((row) => row.hidden === 0)
    .map(presenceOfRow);
  if (dropped.length > 0) {
    await ctx.fanout.send(
      "",
      channelPresenceEventEnvelope(ctx.channelId, ctx.template, [], dropped),
    );
  }
  return ctx.members.count();
}

/**
 * 把**所有人**从这个频道摘掉（群组被删除时）。
 *
 * 上游 `DeleteGroup` 末尾是 `tracker.UntrackByStream(3.<group_id>)`：群没了，
 * 这个群频道对谁都不再有效，所以留在里面的 presence 一次性全部摘掉。
 */
export async function evictAllPresence(ctx: ChannelGroupContext): Promise<void> {
  const dropped = ctx.members
    .dropSessions(ctx.members.sessions())
    .filter((row) => row.hidden === 0)
    .map(presenceOfRow);
  if (dropped.length > 0) {
    await ctx.fanout.send(
      "",
      channelPresenceEventEnvelope(ctx.channelId, ctx.template, [], dropped),
    );
  }
}
