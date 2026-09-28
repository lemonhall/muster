/**
 * 频道消息的**修改与删除**语义（上游 `channelMessageUpdate` / `channelMessageRemove`）。
 *
 * 为什么单独一层：这两条分支共享一条比"发消息"更啰嗦的规则——**只有发送者能改删、
 * 而且只在持久化的频道里才查得到历史**。把它们与发送/加入/离开放在一个类里，
 * 那条规则就被淹没在广播样板里；分出来后，"改不到 = 历史里没有这条"只有一处实现。
 *
 * 两个刻意的形状选择：
 * 1. 时间戳在持久化路径上**换回数据库真值**（上游 `RETURNING create_time`），
 *    而不是用 `Date.now()` 凑——否则重连后读历史会读到不一致的时间；
 * 2. 非持久化频道不做任何查表：上游 `meta.Persistence` 为假时直接构造帧，
 *    所以"这条消息不存在"在非持久化频道里**不会**报错。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_channel.go::Pipeline.channelMessageUpdate
 * 契约源: server/pipeline_channel.go::Pipeline.channelMessageRemove
 *
 * REQ-0001-010
 */

import { CHANNEL_MESSAGE_TYPE, channelMessageAckOf, channelMessageEnvelope } from "../realtime/channel";
import type {
  ChannelMessageEditInput,
  ChannelMessageRefInput,
  ChannelMessageWire,
  ChannelOpResult,
  ChannelTemplate,
} from "../realtime/channel";
import type { ChannelFanout } from "./channel-fanout";
import type { ChannelMembers } from "./channel-members";
import type { ChannelMessages } from "./channel-messages";

export interface ChannelEditContext {
  readonly channelId: string;
  readonly template: ChannelTemplate;
  readonly members: ChannelMembers;
  readonly messages: ChannelMessages;
  readonly fanout: ChannelFanout;
}

const NOT_JOINED_UPDATE = "Must join channel before updating messages";
const NOT_JOINED_REMOVE = "Must join channel before removing messages";
const NOT_FOUND_UPDATE = "Could not find message to update in channel history";
const NOT_FOUND_REMOVE = "Could not find message to remove in channel history";

export async function updateChannelMessage(
  ctx: ChannelEditContext,
  input: ChannelMessageEditInput,
): Promise<ChannelOpResult> {
  const sender = ctx.members.find(input.sessionId, input.userId);
  if (sender === undefined) return { ok: false, code: "BAD_INPUT", message: NOT_JOINED_UPDATE };
  const persistent = sender.persistence === 1;
  const at = Date.now();
  let createTimeMs = at;
  if (persistent) {
    const updated = ctx.messages.update(
      input.messageId,
      input.userId,
      input.username,
      input.content,
      at,
    );
    if (updated === undefined) return { ok: false, code: "BAD_INPUT", message: NOT_FOUND_UPDATE };
    createTimeMs = updated.create_time_ms;
  }
  const message: ChannelMessageWire = {
    messageId: input.messageId,
    code: CHANNEL_MESSAGE_TYPE.chatUpdate,
    senderId: input.userId,
    username: input.username,
    content: input.content,
    createTimeMs,
    updateTimeMs: at,
    persistent,
  };
  return broadcastEdit(ctx, input.cid, input.sessionId, message);
}

export async function removeChannelMessage(
  ctx: ChannelEditContext,
  input: ChannelMessageRefInput,
): Promise<ChannelOpResult> {
  const sender = ctx.members.find(input.sessionId, input.userId);
  if (sender === undefined) return { ok: false, code: "BAD_INPUT", message: NOT_JOINED_REMOVE };
  const persistent = sender.persistence === 1;
  const at = Date.now();
  let createTimeMs = at;
  let updateTimeMs = at;
  if (persistent) {
    const removed = ctx.messages.remove(input.messageId, input.userId);
    if (removed === undefined) return { ok: false, code: "BAD_INPUT", message: NOT_FOUND_REMOVE };
    createTimeMs = removed.create_time_ms;
    updateTimeMs = removed.update_time_ms;
  }
  const message: ChannelMessageWire = {
    messageId: input.messageId,
    code: CHANNEL_MESSAGE_TYPE.chatRemove,
    senderId: input.userId,
    username: input.username,
    // 上游删除帧的内容恒为 `{}`（"这条没了"，不泄露原文）。
    content: "{}",
    createTimeMs,
    updateTimeMs,
    persistent,
  };
  return broadcastEdit(ctx, input.cid, input.sessionId, message);
}

/** 编辑类操作的上行顺序固定为"先广播、后回执"（上游先 `QueueBroadcast` 再回 ack）。 */
async function broadcastEdit(
  ctx: ChannelEditContext,
  cid: string,
  sessionId: string,
  message: ChannelMessageWire,
): Promise<ChannelOpResult> {
  const broadcast = channelMessageEnvelope(ctx.channelId, ctx.template, message);
  await ctx.fanout.send(sessionId, broadcast);
  return {
    ok: true,
    replies: [broadcast, channelMessageAckOf(cid, ctx.channelId, ctx.template, message)],
  };
}
