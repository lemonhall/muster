/**
 * 帧编解码：把 `Envelope` 在"字节"与"对象"之间来回搬。
 *
 * 两种格式与上游 `session_ws.go` 的 `SessionFormat` 一一对应：
 * - `protobuf`：`Envelope` 的二进制线格式（上游 `proto.Unmarshal`）；
 * - `json`：protojson 语义（上游 `protojsonUnmarshaler`），字段名用 lowerCamelCase、
 *   默认值不上线。
 *
 * 编解码器本身来自 `realtime.proto` 的生成物（`src/proto/realtime_pb.ts`），
 * 本文件刻意只做"格式选择 + 抛错边界"这一层薄封装：任何"顺手修一下线格式"的念头
 * 都必须被挡在这里，否则与官方 SDK 的互通就无从谈起了。
 *
 * 契约源（机器可读）：
 * 契约源: server/session_ws.go::sessionWS.consume
 */

import { fromBinary, fromJsonString, toBinary, toJsonString } from "@bufbuild/protobuf";

import { EnvelopeSchema, type Envelope } from "../proto/realtime_pb";

export type SessionFormat = "json" | "protobuf";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 序列化一帧。JSON 分支返回的是 protojson 形状的 UTF-8 字节。 */
export function encodeEnvelope(envelope: Envelope, format: SessionFormat): Uint8Array {
  if (format === "protobuf") return toBinary(EnvelopeSchema, envelope);
  return encoder.encode(toJsonString(EnvelopeSchema, envelope));
}

/**
 * 反序列化一帧。**任何**解析失败都直接抛错——上游对畸形帧的处理是
 * "断开这条连接"，不是"当成空消息继续"，所以这里不能有宽松兜底。
 */
export function decodeEnvelope(bytes: Uint8Array, format: SessionFormat): Envelope {
  if (format === "protobuf") return fromBinary(EnvelopeSchema, bytes);
  return fromJsonString(EnvelopeSchema, decoder.decode(bytes));
}

/** 便于日志与测试：把帧内容说成一句人能读的话。 */
export function describeEnvelope(envelope: Envelope): string {
  const kind = envelope.message.case ?? "(no message)";
  return envelope.cid === "" ? kind : `${kind} cid=${envelope.cid}`;
}
