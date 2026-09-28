/**
 * 频道的线格式：`channel` / `channel_presence_event` / `channel_message` /
 * `channel_message_ack` 四种帧，以及消息与 presence 的内部形状。
 *
 * 三种频道在线上是**同一个消息**，只靠 `room_name` / `group_id` / `user_id_one` +
 * `user_id_two` 三个可选字段区分（上游 `tracker.processEvent` 与
 * `core_channel.go` 的三处 `switch stream.Mode` 都是这个套路）。所以这里把
 * "stream → 那一组字段"收成一个函数，避免四处在拼同一段 switch。
 *
 * 一个容易踩的点：频道 presence **不带** `status` 字段。上游只给 status stream 的
 * presence 设 `UserPresence.status`（`server/tracker.go::processEvent`），频道 presence
 * 上它是缺席的——这与 M3 的在线状态不同，不能复用那个"总是设上"的构造函数。
 *
 * 契约源（机器可读）：
 * 契约源: server/tracker.go::LocalTracker.processEvent
 * 契约源: server/pipeline_channel.go::Pipeline.channelJoin
 * 契约源: server/core_channel.go::ChannelMessageSend
 * 契约源: server/core_channel.go::ChannelMessageUpdate
 * 契约源: server/core_channel.go::ChannelMessageRemove
 *
 * REQ-0001-010
 */

import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";

import {
  ChannelMessageAckSchema,
  ChannelPresenceEventSchema,
  ChannelSchema,
  EnvelopeSchema,
  UserPresenceSchema,
  type Envelope,
  type UserPresence,
} from "../proto/realtime_pb";
import { ChannelMessageSchema } from "../proto/api/api_pb";
import type { ChannelStream } from "./channel-ids";
import type { ChannelMessageCursor } from "./channel-cursor";

/** 一条频道 presence：上游 `Presence` 在频道场景下被客户端看到的那几个字段。 */
export interface ChannelPresence {
  readonly userId: string;
  readonly sessionId: string;
  readonly username: string;
  readonly persistence: boolean;
}

export function channelPresenceOf(
  userId: string,
  sessionId: string,
  username: string,
  persistence: boolean,
): ChannelPresence {
  return { userId, sessionId, username, persistence };
}

/** 那条 `switch stream.Mode` 的结果：三种频道各自该带的那组字段。 */
export interface ChannelTemplate {
  readonly roomName: string;
  readonly groupId: string;
  readonly userIdOne: string;
  readonly userIdTwo: string;
}

export function channelTemplate(stream: ChannelStream): ChannelTemplate {
  switch (stream.mode) {
    case 2:
      return { roomName: stream.label, groupId: "", userIdOne: "", userIdTwo: "" };
    case 3:
      return { roomName: "", groupId: stream.subject, userIdOne: "", userIdTwo: "" };
    case 4:
      return {
        roomName: "",
        groupId: "",
        userIdOne: stream.subject,
        userIdTwo: stream.subcontext,
      };
    default:
      return { roomName: "", groupId: "", userIdOne: "", userIdTwo: "" };
  }
}

/** 频道 presence 的线上形状：**不设** `status`（那是 status stream 的专属字段）。 */
export function toChannelUserPresence(presence: ChannelPresence): UserPresence {
  return create(UserPresenceSchema, {
    userId: presence.userId,
    sessionId: presence.sessionId,
    username: presence.username,
    persistence: presence.persistence,
  });
}

/** 频道消息的内部形状。时间用毫秒（DO 的 SQLite 只存整数，纳秒级精度是本项目的登记偏差）。 */
export interface ChannelMessageWire {
  readonly messageId: string;
  readonly code: number;
  readonly senderId: string;
  readonly username: string;
  readonly content: string;
  readonly createTimeMs: number;
  readonly updateTimeMs: number;
  readonly persistent: boolean;
}

/** `channel_message_ack` 的内部形状：没有 content/sender_id（上游的 ack 就是这些字段）。 */
export interface ChannelMessageAckWire {
  readonly messageId: string;
  readonly code: number;
  readonly username: string;
  readonly createTimeMs: number;
  readonly updateTimeMs: number;
  readonly persistent: boolean;
}

function templateFields(template: ChannelTemplate): {
  roomName: string;
  groupId: string;
  userIdOne: string;
  userIdTwo: string;
} {
  return {
    roomName: template.roomName,
    groupId: template.groupId,
    userIdOne: template.userIdOne,
    userIdTwo: template.userIdTwo,
  };
}

/** `channel_join` 的回执：当前成员（不含隐藏者、不含"刚加入的自己"）+ 自己那条 presence。 */
export function channelEnvelope(
  cid: string,
  channelId: string,
  template: ChannelTemplate,
  self: ChannelPresence,
  presences: readonly ChannelPresence[],
): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "channel",
      value: create(ChannelSchema, {
        id: channelId,
        presences: presences.map(toChannelUserPresence),
        self: toChannelUserPresence(self),
        ...templateFields(template),
      }),
    },
  });
}

/** 上下线事件。joins 与 leaves 至少一边非空才有发出去的意义（上游也是这么攒批的）。 */
export function channelPresenceEventEnvelope(
  channelId: string,
  template: ChannelTemplate,
  joins: readonly ChannelPresence[],
  leaves: readonly ChannelPresence[],
): Envelope {
  return create(EnvelopeSchema, {
    message: {
      case: "channelPresenceEvent",
      value: create(ChannelPresenceEventSchema, {
        channelId,
        joins: joins.map(toChannelUserPresence),
        leaves: leaves.map(toChannelUserPresence),
        ...templateFields(template),
      }),
    },
  });
}

/** 广播给频道成员的消息帧。它**没有** cid：上游 `router.SendToStream` 发出去的就是这样。 */
export function channelMessageEnvelope(
  channelId: string,
  template: ChannelTemplate,
  message: ChannelMessageWire,
): Envelope {
  return create(EnvelopeSchema, {
    message: {
      case: "channelMessage",
      value: create(ChannelMessageSchema, {
        channelId,
        messageId: message.messageId,
        code: message.code,
        senderId: message.senderId,
        username: message.username,
        content: message.content,
        createTime: timestampFromDate(new Date(message.createTimeMs)),
        updateTime: timestampFromDate(new Date(message.updateTimeMs)),
        persistent: message.persistent,
        ...templateFields(template),
      }),
    },
  });
}

/** 发送/编辑/删除的回执：带 cid（它是对某一帧的应答）。 */
export function channelMessageAckEnvelope(
  cid: string,
  channelId: string,
  template: ChannelTemplate,
  ack: ChannelMessageAckWire,
): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "channelMessageAck",
      value: create(ChannelMessageAckSchema, {
        channelId,
        messageId: ack.messageId,
        code: ack.code,
        username: ack.username,
        createTime: timestampFromDate(new Date(ack.createTimeMs)),
        updateTime: timestampFromDate(new Date(ack.updateTimeMs)),
        persistent: ack.persistent,
        ...templateFields(template),
      }),
    },
  });
}

/**
 * 从一条完整的频道消息里取出回执：上游的 ack **不含** `sender_id` 与 `content`，
 * 但它与广播帧共用 `message_id` / `code` / `username` / 两个时间戳 / `persistent`。
 */
export function channelMessageAckOf(
  cid: string,
  channelId: string,
  template: ChannelTemplate,
  message: ChannelMessageWire,
): Envelope {
  return channelMessageAckEnvelope(cid, channelId, template, {
    messageId: message.messageId,
    code: message.code,
    username: message.username,
    createTimeMs: message.createTimeMs,
    updateTimeMs: message.updateTimeMs,
    persistent: message.persistent,
  });
}

/** `ChannelMessageTypeChat`：上游 `pipeline_channel.go` 里第一个 iota 值。 */
export const CHANNEL_MESSAGE_TYPE = {
  chat: 0,
  chatUpdate: 1,
  chatRemove: 2,
} as const;

/**
 * 一次频道操作的结果。
 *
 * 为什么把"要发回去的帧"（而不是"回执对象"）当成返回值：频道在**另一个 DO** 里，
 * 帧的构造依赖那边的成员表与消息表（快照、`self`、时间戳都要真值），所以帧在那边造好、
 * 以 protojson 过一道 HTTP 回到分片。`cid` 只是原样透传，不参与任何判断。
 *
 * 失败带上错误码，是因为上游对"输入不合法"与"服务端异常"分两种码
 * （`BAD_INPUT` = 3、`RUNTIME_EXCEPTION` = 0），而**两条都关连接**——这个决定权在管线那层。
 */
export type ChannelOpResult =
  | { readonly ok: true; readonly replies: readonly Envelope[] }
  | {
      readonly ok: false;
      readonly code: "BAD_INPUT" | "RUNTIME_EXCEPTION";
      readonly message: string;
    };

/** `channel_join` 的入参（`cid` 原样透传，见 `ChannelOpResult` 的说明）。 */
export interface ChannelJoinInput {
  readonly cid: string;
  readonly channelId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly username: string;
  readonly persistence: boolean;
  readonly hidden: boolean;
}

/** `channel_leave` / 一条会话在频道里的身份。 */
export interface ChannelMemberInput {
  readonly cid: string;
  readonly channelId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly username: string;
}

export interface ChannelMessageInput extends ChannelMemberInput {
  readonly content: string;
}

/** 删除要指名道姓地说"哪一条"。 */
export interface ChannelMessageRefInput extends ChannelMemberInput {
  readonly messageId: string;
}

/** 编辑：既要指名道姓，又要新内容。 */
export interface ChannelMessageEditInput extends ChannelMessageRefInput {
  readonly content: string;
}

/** 读频道历史的入参：`cursor` 由调用方先校验（解不出来 / 方向或频道不匹配都该先拒）。 */
export interface ChannelHistoryInput {
  readonly limit: number;
  readonly forward: boolean;
  readonly cursor: ChannelMessageCursor | undefined;
}

/**
 * 频道域对实时管线暴露的能力。
 *
 * 管线只认这个接口：`join` / `leave` / `send` / `update` / `remove` 的**实现**在
 * 会话分片（它去调频道 DO），测试里可以换成记录调用的假实现——这正是
 * "校验顺序与成员语义分开断言"能成立的原因。
 */
export interface ChannelService {
  join(input: ChannelJoinInput): Promise<ChannelOpResult>;
  leave(input: ChannelMemberInput): Promise<ChannelOpResult>;
  send(input: ChannelMessageInput): Promise<ChannelOpResult>;
  update(input: ChannelMessageEditInput): Promise<ChannelOpResult>;
  remove(input: ChannelMessageRefInput): Promise<ChannelOpResult>;
}
