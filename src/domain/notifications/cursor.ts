/**
 * 通知列表的游标。
 *
 * 上游用的是 `base64.RawURLEncoding(gob(notificationCacheableCursor))`；本项目沿用
 * base64url(JSON)（ECN-0004 的同一决定，见 ECN-0008）。能被客户端观察到的只有一条：
 * 坏游标 → `400 {"code":3,"message":"Malformed cursor was used."}`。
 *
 * "零点游标"（`createTime = 0, id = ""`）是**合法**输入：上游在空列表 + 无入参游标时
 * 回的就是它，客户端会把它原样带回来。所以这里的解码不能把空 id 当成非法。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_notification.go::NotificationList
 *
 * REQ-0001-013
 */

import { invalidArgument } from "../../http/errors";
import { MAX_CURSOR_LENGTH, fromBase64Url, toBase64Url } from "../base64url";

export interface NotificationCursor {
  readonly createTime: number;
  readonly id: string;
}

const INVALID_CURSOR = "Malformed cursor was used.";

export function encodeNotificationCursor(cursor: NotificationCursor | null): string {
  if (cursor === null) return toBase64Url(JSON.stringify({ t: 0, i: "" }));
  return toBase64Url(JSON.stringify({ t: cursor.createTime, i: cursor.id }));
}

export function decodeNotificationCursor(raw: string): NotificationCursor {
  if (raw.length > MAX_CURSOR_LENGTH) throw invalidArgument(INVALID_CURSOR);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(raw));
  } catch {
    throw invalidArgument(INVALID_CURSOR);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidArgument(INVALID_CURSOR);
  }
  const record = parsed as Record<string, unknown>;
  const createTime = record.t;
  const id = record.i;
  if (typeof createTime !== "number" || !Number.isInteger(createTime) || createTime < 0) {
    throw invalidArgument(INVALID_CURSOR);
  }
  if (typeof id !== "string") throw invalidArgument(INVALID_CURSOR);
  return { createTime, id };
}
