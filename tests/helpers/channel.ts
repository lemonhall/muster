import { create } from "@bufbuild/protobuf";

import {
  ChannelJoinSchema,
  ChannelLeaveSchema,
  ChannelMessageRemoveSchema,
  ChannelMessageSendSchema,
  ChannelMessageUpdateSchema,
  EnvelopeSchema,
  type Envelope,
  type UserPresence,
} from "../../src/proto/realtime_pb";
import type {
  ChannelJoinInput,
  ChannelMemberInput,
  ChannelMessageEditInput,
  ChannelMessageInput,
  ChannelMessageRefInput,
  ChannelOpResult,
  ChannelService,
} from "../../src/realtime/channel";
import { sendFrame, waitForFrame, type TestSocket } from "./realtime-socket";

/**
 * M4 频道套件的共享工装：造五种频道帧、把频道帧拆成可断言的形状，
 * 以及一个"把调用原样记下来"的假 `ChannelService`。
 *
 * 文件名不带 `.test.ts`，不会被 vitest 收集（见 `vitest.config.ts` 的 include）。
 */

export interface JoinOptions {
  readonly persistence?: boolean;
  readonly hidden?: boolean;
}

export function channelJoinEnvelope(
  cid: string,
  target: string,
  type = 1,
  options: JoinOptions = {},
): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "channelJoin",
      value: create(ChannelJoinSchema, {
        target,
        type,
        // 上游的 `BoolValue` 语义：**不设**与"设成 false"不同（缺省是持久化、不隐藏），
        // 所以这里按"给没给"决定要不要带上字段，而不是直接塞一个 undefined。
        ...(options.persistence === undefined ? {} : { persistence: options.persistence }),
        ...(options.hidden === undefined ? {} : { hidden: options.hidden }),
      }),
    },
  });
}

export function channelLeaveEnvelope(cid: string, channelId: string): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: { case: "channelLeave", value: create(ChannelLeaveSchema, { channelId }) },
  });
}

export function channelMessageSendEnvelope(
  cid: string,
  channelId: string,
  content: string,
): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "channelMessageSend",
      value: create(ChannelMessageSendSchema, { channelId, content }),
    },
  });
}

export function channelMessageUpdateEnvelope(
  cid: string,
  channelId: string,
  messageId: string,
  content: string,
): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "channelMessageUpdate",
      value: create(ChannelMessageUpdateSchema, { channelId, messageId, content }),
    },
  });
}

export function channelMessageRemoveEnvelope(
  cid: string,
  channelId: string,
  messageId: string,
): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "channelMessageRemove",
      value: create(ChannelMessageRemoveSchema, { channelId, messageId }),
    },
  });
}

function presenceKey(presence: UserPresence): string {
  return `${presence.userId}/${presence.sessionId}/${presence.persistence ? "p" : "-"}`;
}

/**
 * 在真 socket 上加入一个房间，等回执（不关心回执内容时用它，省得每个用例都写一遍）。
 * 注意"新加入者也会收到自己的 joins 事件"——需要做负向断言的用例要另等那条事件。
 */
export async function joinRoom(
  target: TestSocket,
  cid: string,
  room: string,
  options: JoinOptions = {},
): Promise<void> {
  sendFrame(target, channelJoinEnvelope(cid, room, 1, options));
  await waitForFrame(target, (frame) => frame.cid === cid && frame.message.case === "channel");
}

/**
 * 发一条频道消息，等**发送者自己**那条广播，返回 message_id。
 *
 * 为什么从广播里取 id 而不是从回执：两条帧都带 `message_id`，但广播是"频道里所有人
 * 都会看到的那一份"，拿它来断言等于顺便证明了广播确实发出去了。
 */
export async function sendChannelMessage(
  target: TestSocket,
  cid: string,
  channelId: string,
  content: string,
): Promise<string> {
  sendFrame(target, channelMessageSendEnvelope(cid, channelId, content));
  const broadcast = await waitForFrame(target, (frame) => frame.message.case === "channelMessage");
  return channelMessageOf(broadcast).messageId;
}

/** `channel_join` 的回执：`{ channelId, self, presences }`（presences 用字符串表比对）。 */
export function channelReply(envelope: Envelope): {
  channelId: string;
  self: string;
  presences: string[];
} {
  if (envelope.message.case !== "channel") {
    throw new Error(`期望一帧 channel，实际是 ${envelope.message.case ?? "(空)"}`);
  }
  const channel = envelope.message.value;
  if (channel.self === undefined) throw new Error("channel 回执缺少 self");
  return {
    channelId: channel.id,
    self: presenceKey(channel.self),
    presences: channel.presences.map(presenceKey),
  };
}

/** `channel_presence_event` 的 joins/leaves → 字符串表。 */
export function channelEventKeys(envelope: Envelope): { joins: string[]; leaves: string[] } {
  if (envelope.message.case !== "channelPresenceEvent") {
    throw new Error(`期望 channel_presence_event，实际是 ${envelope.message.case ?? "(空)"}`);
  }
  const event = envelope.message.value;
  return { joins: event.joins.map(presenceKey), leaves: event.leaves.map(presenceKey) };
}

export interface ChannelMessageShape {
  readonly messageId: string;
  readonly channelId: string;
  readonly code: number;
  readonly senderId: string;
  readonly username: string;
  readonly content: string;
  readonly persistent: boolean;
}

export function channelMessageOf(envelope: Envelope): ChannelMessageShape {
  if (envelope.message.case !== "channelMessage") {
    throw new Error(`期望 channel_message，实际是 ${envelope.message.case ?? "(空)"}`);
  }
  const message = envelope.message.value;
  return {
    messageId: message.messageId,
    channelId: message.channelId,
    code: message.code ?? -1,
    senderId: message.senderId,
    username: message.username,
    content: message.content,
    persistent: message.persistent ?? false,
  };
}

export interface ChannelAckShape {
  readonly messageId: string;
  readonly channelId: string;
  readonly code: number;
  readonly username: string;
  readonly persistent: boolean;
}

export function channelAckOf(envelope: Envelope): ChannelAckShape {
  if (envelope.message.case !== "channelMessageAck") {
    throw new Error(`期望 channel_message_ack，实际是 ${envelope.message.case ?? "(空)"}`);
  }
  const ack = envelope.message.value;
  return {
    messageId: ack.messageId,
    channelId: ack.channelId,
    code: ack.code ?? -1,
    username: ack.username,
    persistent: ack.persistent ?? false,
  };
}

export interface RecordedChannelCall {
  readonly op: "join" | "leave" | "send" | "update" | "remove";
  readonly input:
    | ChannelJoinInput
    | ChannelMemberInput
    | ChannelMessageInput
    | ChannelMessageEditInput
    | ChannelMessageRefInput;
}

export interface RecordedChannel {
  readonly service: ChannelService;
  readonly calls: RecordedChannelCall[];
  /** 下一次调用的返回值；默认"成功但没有任何回帧"。 */
  result: ChannelOpResult;
}

/**
 * 假的频道服务：把调用记下来，回一个可控的结果。
 *
 * 为什么需要它：管线这一层的职责是**校验顺序与错误码**（上游 `pipeline_channel.go`），
 * 而"谁在这个频道里"是频道 DO 的职责。假的实现让这两件事可以分别断言——
 * 真 DO 的语义在 `tests/integration/channel/` 里另测。
 */
export function recordingChannel(
  result: ChannelOpResult = { ok: true, replies: [] },
): RecordedChannel {
  const calls: RecordedChannelCall[] = [];
  const holder: RecordedChannel = {
    calls,
    result,
    service: {
      async join(input) {
        calls.push({ op: "join", input });
        return holder.result;
      },
      async leave(input) {
        calls.push({ op: "leave", input });
        return holder.result;
      },
      async send(input) {
        calls.push({ op: "send", input });
        return holder.result;
      },
      async update(input) {
        calls.push({ op: "update", input });
        return holder.result;
      },
      async remove(input) {
        calls.push({ op: "remove", input });
        return holder.result;
      },
    },
  };
  return holder;
}
