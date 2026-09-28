/**
 * 好友域的两个游标：好友列表的 (state, position) 与好友的好友的 (source, destination)。
 *
 * 与上游一致的三条可观测行为（这些才是契约）：
 *   1. 游标坏了 → `400 {"code":3,"message":"Cursor is invalid."}`（上游 api 层把
 *      `ErrFriendInvalidCursor` 换成这句）；
 *   2. 游标指向**下一页的第一行**，下一页从它开始（含），所以不会漏、也不会重；
 *   3. 带 `state` 过滤时，游标里的 state 必须与过滤条件一致，否则报同一句"游标无效"——
 *      上游原话是"也许调用方拿了一个改过过滤条件的旧游标"。
 *
 * 编码是 base64url(JSON) 而不是 gob，理由与存储游标完全相同
 * （见 docs/ecn/ECN-0004-storage-cursor-encoding.md、ECN-0008）。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_friend.go::ListFriends
 * 契约源: server/core_friend.go::ListFriendsOfFriends
 *
 * REQ-0001-011
 */

import { invalidArgument } from "../../http/errors";
import { MAX_CURSOR_LENGTH, fromBase64Url, toBase64Url } from "../base64url";
import type { EdgeCursor, FriendsOfFriendsCursor } from "./types";

const INVALID_CURSOR = "Cursor is invalid.";

export function encodeEdgeCursor(cursor: EdgeCursor): string {
  return toBase64Url(JSON.stringify({ s: cursor.state, p: cursor.position }));
}

export function decodeEdgeCursor(raw: string): EdgeCursor {
  const record = parseRecord(raw);
  const state = record.s;
  const position = record.p;
  if (typeof state !== "number" || !Number.isInteger(state) || state < 0 || state > 3) {
    throw invalidArgument(INVALID_CURSOR);
  }
  if (typeof position !== "number" || !Number.isInteger(position) || position < 0) {
    throw invalidArgument(INVALID_CURSOR);
  }
  return { state, position };
}

export function encodeFriendsOfFriendsCursor(cursor: FriendsOfFriendsCursor): string {
  return toBase64Url(JSON.stringify({ s: cursor.sourceId, d: cursor.destinationId }));
}

export function decodeFriendsOfFriendsCursor(raw: string): FriendsOfFriendsCursor {
  const record = parseRecord(raw);
  const sourceId = record.s;
  const destinationId = record.d;
  // 上游显式拒绝"字段为空"的游标（`incomingCursor.SourceId == "" || DestinationId == ""`）。
  if (typeof sourceId !== "string" || sourceId === "") throw invalidArgument(INVALID_CURSOR);
  if (typeof destinationId !== "string" || destinationId === "") throw invalidArgument(INVALID_CURSOR);
  return { sourceId, destinationId };
}

function parseRecord(raw: string): Record<string, unknown> {
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
  return parsed as Record<string, unknown>;
}

/** 带 `state` 过滤时用的守卫：游标里的 state 与请求里的过滤条件不一致 → 游标无效。 */
export function assertCursorMatchesState(cursor: EdgeCursor, state: number | undefined): void {
  if (state !== undefined && cursor.state !== state) throw invalidArgument(INVALID_CURSOR);
}
