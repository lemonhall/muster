/**
 * 频道消息历史的游标。
 *
 * 与存储域同理（[ECN-0004](../../docs/ecn/ECN-0004-storage-cursor-encoding.md)）：
 * 上游把 `channelMessageListCursor` 用 gob 编码后再 base64url，本项目换成
 * base64url(JSON)。游标对客户端是**不透明**的，只有服务端解它，所以这不影响互通；
 * 真正是契约的是下面三条**可观测**行为：
 *
 * 1. 任何形状不对的游标（坏 base64、缺字段、方向不一致、不是同一个频道）→
 *    上游 `ErrChannelCursorInvalid`，REST 层回 `Cursor is invalid or expired.`；
 * 2. 游标里存的是"上一页的最后一条"：`(create_time, id)` 六元组比较决定从哪继续；
 * 3. `is_next` 决定"这是往前翻还是往回翻"，`forward` 决定"用户视角的正序还是倒序"——
 *    两者是**独立**的两根轴，混起来就会翻出重复页（见 `channel-history.ts` 的推导）。
 *
 * 与上游的差异只有时间精度：上游 `create_time` 是 Postgres `timestamptz`（纳秒），
 * 本项目的消息时间戳是毫秒（DO 的 SQLite 只存整数）。见 ECN-0007。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_channel.go::channelMessageListCursor
 * 契约源: server/core_channel.go::ChannelMessagesList
 *
 * REQ-0001-010
 */

import type { ChannelStream } from "./channel-ids";

export interface ChannelMessageCursor {
  readonly mode: number;
  readonly subject: string;
  readonly subcontext: string;
  readonly label: string;
  readonly createTimeMs: number;
  readonly id: string;
  readonly forward: boolean;
  readonly isNext: boolean;
}

const MAX_CURSOR_LENGTH = 4096;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

export function encodeChannelCursor(cursor: ChannelMessageCursor): string {
  return toBase64Url(
    JSON.stringify({
      m: cursor.mode,
      s: cursor.subject,
      c: cursor.subcontext,
      l: cursor.label,
      t: cursor.createTimeMs,
      i: cursor.id,
      f: cursor.forward,
      n: cursor.isNext,
    }),
  );
}

/** 解不出来一律返回 null：调用方只有一种回法（`Cursor is invalid or expired.`）。 */
export function decodeChannelCursor(raw: string): ChannelMessageCursor | null {
  if (raw.length > MAX_CURSOR_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const mode = record["m"];
  const subject = record["s"];
  const subcontext = record["c"];
  const label = record["l"];
  const createTimeMs = record["t"];
  const id = record["i"];
  const forward = record["f"];
  const isNext = record["n"];
  if (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 255) return null;
  if (typeof subject !== "string" || typeof subcontext !== "string" || typeof label !== "string") {
    return null;
  }
  if (typeof createTimeMs !== "number" || !Number.isInteger(createTimeMs)) return null;
  if (typeof id !== "string" || typeof forward !== "boolean" || typeof isNext !== "boolean") {
    return null;
  }
  return { mode, subject, subcontext, label, createTimeMs, id, forward, isNext };
}

/**
 * 游标必须属于**同一个频道、同一个方向**，否则上游同样报 invalid。
 * 上游是在 SQL 之前做这四条比较（模式、subject、subcontext、label，以及 forward）。
 */
export function cursorMatchesStream(
  cursor: ChannelMessageCursor,
  stream: ChannelStream,
  forward: boolean,
): boolean {
  return (
    cursor.forward === forward &&
    cursor.mode === stream.mode &&
    cursor.subject === stream.subject &&
    cursor.subcontext === stream.subcontext &&
    cursor.label === stream.label
  );
}
