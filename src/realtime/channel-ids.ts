/**
 * 频道标识符：`2.<room>` / `3.<group_id>` / `4.<user_one>.<user_two>`。
 *
 * 频道 id 是**客户端可见的字符串**，也是本项目里频道 DO 的键来源，所以它有两个职责：
 * 1. 对外形状（哪些字符串是合法频道、非法时回什么话）；
 * 2. 对内规范化（同一频道只能有一个键，大小写/写法差异不能把它拆成两个 DO）。
 *
 * 上游把"形状校验"和"查库校验"写在同一个 `BuildChannelId` 里；这里把两者分开：
 * 本模块只管**形状**（纯函数、可单测），查库那部分（DM 对方是否存在、群组成员资格）
 * 在 join 路径上做，错误文案与上游逐字一致。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_channel.go::BuildChannelId
 * 契约源: server/core_channel.go::ChannelIdToStream
 * 契约源: server/core_channel.go::StreamToChannelId
 * 契约源: server/tracker.go::StreamModeChannel
 *
 * REQ-0001-010
 */

import { byteLength } from "../domain/identity/service/validate";
import { normalizeUserId } from "./identifiers";

/**
 * 上游 `server/tracker.go` 的 `StreamMode` 常量（iota 顺序，数值即契约）：
 * notifications=0、status=1、channel=2、group=3、dm=4。
 */
export const STREAM_MODE = {
  notifications: 0,
  status: 1,
  channel: 2,
  group: 3,
  direct: 4,
} as const;

/** `ChannelJoin.Type` 的枚举值（proto 里的数字，客户端直接传）。 */
export const CHANNEL_JOIN_TYPE = {
  unspecified: 0,
  room: 1,
  direct: 2,
  group: 3,
} as const;

/** 上游 `runtime.ErrInvalidChannelTarget` 的原文。 */
const ERR_INVALID_TARGET = "Invalid channel target";
/** 上游 `runtime.ErrInvalidChannelType` 的原文。 */
const ERR_INVALID_TYPE = "Invalid channel type";

export interface ChannelStream {
  readonly mode: number;
  /** UUID 大写标准形；房间频道是空串。 */
  readonly subject: string;
  /** 私聊的第二个人；其余是空串。 */
  readonly subcontext: string;
  /** 房间名；群组与私聊是空串。 */
  readonly label: string;
}

export type BuildChannelIdResult =
  | { readonly ok: true; readonly channelId: string; readonly stream: ChannelStream }
  | { readonly ok: false; readonly message: string };

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const UUID_SHAPE = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

/** 上游 `utf8.ValidString` 的等价物：JS 字符串里混进孤立代理项时，往返会变 U+FFFD。 */
function isValidUtf8(value: string): boolean {
  return new TextDecoder().decode(new TextEncoder().encode(value)) === value;
}

export function streamToChannelId(stream: ChannelStream): string {
  return `${stream.mode}.${stream.subject}.${stream.subcontext}.${stream.label}`;
}

/**
 * 解析频道 id。返回的 stream 是**规范形**（UUID 统一大写），所以客户端大小写不同
 * 的同一个频道会落到同一个键上；形状不合法返回 null（调用方再决定回什么错误）。
 */
export function channelIdToStream(channelId: string): ChannelStream | null {
  if (channelId === "") return null;
  const components = channelId.split(".");
  // 上游是 `SplitN(id, ".", 4)`：第四段允许含点，所以拆出多于 4 段时要把尾巴并回去。
  if (components.length < 4) return null;
  const [mode, subject, subcontext, ...rest] = components;
  const label = rest.join(".");
  if (mode === undefined || subject === undefined || subcontext === undefined) return null;

  switch (mode) {
    case String(STREAM_MODE.channel): {
      // 上游要求 subject 与 subcontext 都为空，label 是 1..64 **字节**。
      if (subject !== "" || subcontext !== "") return null;
      if (!isParseableRoomName(label)) return null;
      return { mode: STREAM_MODE.channel, subject: "", subcontext: "", label };
    }
    case String(STREAM_MODE.group): {
      if (label !== "") return null;
      const groupId = subject === "" ? null : normalizeUserId(subject);
      if (subject !== "" && groupId === null) return null;
      return { mode: STREAM_MODE.group, subject: groupId ?? "", subcontext: "", label: "" };
    }
    case String(STREAM_MODE.direct): {
      if (label !== "") return null;
      const one = subject === "" ? null : normalizeUserId(subject);
      const two = subcontext === "" ? null : normalizeUserId(subcontext);
      if ((subject !== "" && one === null) || (subcontext !== "" && two === null)) return null;
      return { mode: STREAM_MODE.direct, subject: one ?? "", subcontext: two ?? "", label: "" };
    }
    default:
      return null;
  }
}

function isValidRoomName(label: string): boolean {
  const length = byteLength(label);
  return length >= 1 && length <= 64 && !CONTROL_CHARS.test(label) && isValidUtf8(label);
}

/**
 * 解析路径的宽松版：上游 `ChannelIdToStream` 对 label 只查 `1..64` **字节**，
 * 不查控制字符与 UTF-8（那两条只在 `BuildChannelId` 建频道时查）。
 *
 * 两者分开是有意义的：解析是"客户端回头拿一个频道 id 来用"，判定要与上游一致——
 * 否则一句本该是"你得先加入这个频道"的话会变成"频道 id 非法"。
 */
function isParseableRoomName(label: string): boolean {
  const length = byteLength(label);
  return length >= 1 && length <= 64;
}

/**
 * 按上游规则构造频道 id（**只做形状校验**）。
 *
 * 上游 `BuildChannelId` 在同一函数里还查了库（DM 的对方是否存在且没拉黑、群组成员资格）；
 * 那两条依赖数据库，放在 join 路径上做（`src/durable/channel-call.ts` 的 `channelJoin`）。
 * 错误文案保持逐字一致，所以调用方不需要再拼字符串。
 */
export function buildChannelId(userId: string, target: string, type: number): BuildChannelIdResult {
  if (target === "") return { ok: false, message: ERR_INVALID_TARGET };

  switch (type) {
    case CHANNEL_JOIN_TYPE.unspecified:
    case CHANNEL_JOIN_TYPE.room: {
      if (byteLength(target) < 1 || byteLength(target) > 64) {
        return { ok: false, message: `Channel name is required and must be 1-64 chars: ${ERR_INVALID_TARGET}` };
      }
      if (CONTROL_CHARS.test(target)) {
        return { ok: false, message: `Channel name must not contain control chars: ${ERR_INVALID_TARGET}` };
      }
      if (!isValidUtf8(target)) {
        return { ok: false, message: `Channel name must only contain valid UTF-8 bytes: ${ERR_INVALID_TARGET}` };
      }
      const stream: ChannelStream = {
        mode: STREAM_MODE.channel,
        subject: "",
        subcontext: "",
        label: target,
      };
      return { ok: true, channelId: streamToChannelId(stream), stream };
    }

    case CHANNEL_JOIN_TYPE.direct: {
      const other = UUID_SHAPE.test(target) ? normalizeUserId(target) : null;
      // 上游连 nil uuid 都拒（`uid == uuid.Nil`），这里用"全 0"的写法表达同一件事。
      if (other === null || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(other)) {
        return { ok: false, message: `Invalid user ID in direct message join: ${ERR_INVALID_TARGET}` };
      }
      const self = normalizeUserId(userId);
      if (self === null) {
        return { ok: false, message: `Invalid user ID in direct message join: ${ERR_INVALID_TARGET}` };
      }
      // 上游按 `uuid.String()`（小写）比较大小决定谁当 subject；本项目统一大写，
      // 只要两支用同一个规范形，先后顺序就稳定（同一个人私聊自己也落在一支上）。
      const [one, two] = self > other ? [other, self] : [self, other];
      const stream: ChannelStream = {
        mode: STREAM_MODE.direct,
        subject: one,
        subcontext: two,
        label: "",
      };
      return { ok: true, channelId: streamToChannelId(stream), stream };
    }

    case CHANNEL_JOIN_TYPE.group: {
      const groupId = UUID_SHAPE.test(target) ? normalizeUserId(target) : null;
      if (groupId === null) {
        return { ok: false, message: `Invalid group ID in group channel join: ${ERR_INVALID_TARGET}` };
      }
      const stream: ChannelStream = {
        mode: STREAM_MODE.group,
        subject: groupId,
        subcontext: "",
        label: "",
      };
      return { ok: true, channelId: streamToChannelId(stream), stream };
    }

    default:
      return { ok: false, message: ERR_INVALID_TYPE };
  }
}
