import { create } from "@bufbuild/protobuf";

import {
  ChannelJoinSchema,
  ChannelMessageSendSchema,
  EnvelopeSchema,
  type Envelope,
  type UserPresence,
} from "../../src/proto/realtime_pb";

/**
 * M4 E2E 的频道工装：造频道帧、把频道帧拆成可断言的形状。
 *
 * E2E 与集成测试各留一份工装是**刻意**的：`tests/helpers/channel.ts` 那份 import
 * `cloudflare:test`（能直接拿 DO stub、直接开假会话），只能在测试池里跑；这里的这份
 * 只能用网络说话，所以它只做两件与运行环境无关的事——编码请求、解码响应。
 *
 * 文件名不带 `.e2e.test.ts`，不会被 vitest 收集。
 */

/**
 * `channel_join`。`type` 用 proto 里的数字：1=ROOM、2=DIRECT、3=GROUP（0 与 1 同义）。
 *
 * `persistence` / `hidden` 是 `google.protobuf.BoolValue`：**不给**和**给 false** 不是
 * 同一件事（不给走上游默认值），所以这里按"字段有没有出现"决定带不带，而不是塞 undefined。
 */
export function channelJoin(
  cid: string,
  target: string,
  type = 1,
  options: { readonly persistence?: boolean; readonly hidden?: boolean } = {},
): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "channelJoin",
      value: create(ChannelJoinSchema, {
        target,
        type,
        ...(options.persistence === undefined ? {} : { persistence: options.persistence }),
        ...(options.hidden === undefined ? {} : { hidden: options.hidden }),
      }),
    },
  });
}

/**
 * `channel_message_send`。
 *
 * `content` 必须是 **JSON 对象**的文本（上游 `json.Valid(v) && TrimSpace(v)[0] == '{'`）：
 * 裸字符串、数组、标量都会被判 `BAD_INPUT` 并**关闭连接**——这个坑在集成测试里踩过一次，
 * 所以工装这里把话说在明处。
 */
export function channelMessageSend(cid: string, channelId: string, content: string): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "channelMessageSend",
      value: create(ChannelMessageSendSchema, { channelId, content }),
    },
  });
}

function presenceKey(presence: UserPresence): string {
  return `${presence.userId}/${presence.sessionId}/${presence.persistence ? "p" : "-"}`;
}

export interface JoinReply {
  readonly channelId: string;
  readonly self: string;
  readonly presences: readonly string[];
}

/** `channel_join` 的回执：`{ channelId, self, presences }`（presence 摊成字符串表比对）。 */
export function channelReply(envelope: Envelope): JoinReply {
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

export interface LiveMessage {
  readonly messageId: string;
  readonly channelId: string;
  readonly senderId: string;
  readonly username: string;
  readonly content: string;
  readonly persistent: boolean;
}

/** 一帧 `channel_message`（**广播**那条；回执是另一种帧类型，这里不收）。 */
export function channelMessageOf(envelope: Envelope): LiveMessage {
  if (envelope.message.case !== "channelMessage") {
    throw new Error(`期望 channel_message，实际是 ${envelope.message.case ?? "(空)"}`);
  }
  const message = envelope.message.value;
  return {
    messageId: message.messageId,
    channelId: message.channelId,
    senderId: message.senderId,
    username: message.username,
    content: message.content,
    persistent: message.persistent ?? false,
  };
}

/** 一条连接上收到过的全部频道广播，按**到达顺序**。顺序正是这里要断言的东西之一。 */
export function liveMessages(frames: readonly Envelope[]): LiveMessage[] {
  return frames.filter((frame) => frame.message.case === "channelMessage").map(channelMessageOf);
}

/** 房间频道的 id 形状（上游 `StreamToChannelId`）：`2.<空>.<空>.<房间名>`。 */
export function roomChannelId(room: string): string {
  return `2...${room}`;
}

/** `roomChannelId` 的逆：从房间频道 id 取回房间名（丢掉 `2...` 这四字节前缀）。 */
export function roomOf(channelId: string): string {
  return channelId.slice(4);
}

/** 频道历史的 REST 路径。id 里有三个点，点不是保留字符，照样编码一下求稳。 */
export function channelHistoryPath(channelId: string): string {
  return `/v2/channel/${encodeURIComponent(channelId)}`;
}
