/**
 * 群组域的两个游标：成员/群列表的 `(state, position)` 与群组列表的复合游标。
 *
 * 能被客户端观察到的部分是**错误文案**，两种游标不同（逐字来自上游，别想当然地统一）：
 *   - 成员列表、用户群组列表 → `Cursor is invalid.`
 *     （上游 `core_group.go` 返回 `ErrGroupUserInvalidCursor` / `ErrUserGroupInvalidCursor`，
 *     `api_group.go` 再把它们换成这一句）；
 *   - 群组列表 → `Malformed cursor was used.`
 *     （上游 `ListGroups` 自己就是这句：base64 与 gob 两处解码失败都回它，
 *     注意它**不是** `Cursor is invalid.`，也不是 `api_group.go` 那层翻译的）。
 *
 * 编码是 base64url(JSON)，理由与存储游标相同（ECN-0004、ECN-0008）：上游的 gob 是
 * 内部结构，没有任何客户端协议承诺它，而"翻页不重不漏"才是契约。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_group.go::ListGroupUsers
 * 契约源: server/core_group.go::ListUserGroups
 * 契约源: server/core_group.go::ListGroups
 *
 * REQ-0001-012
 */

import { invalidArgument } from "../../http/errors";
import { MAX_CURSOR_LENGTH, fromBase64Url, toBase64Url } from "../base64url";
import type { EdgeCursor, GroupListCursor } from "./types";

const INVALID_CURSOR = "Cursor is invalid.";
/** `ListGroups` 自己那一句，与上面那句**不同**（上游两条路径的文案确实不一致）。 */
const MALFORMED_CURSOR = "Malformed cursor was used.";

export function encodeEdgeCursor(cursor: EdgeCursor): string {
  return toBase64Url(JSON.stringify({ s: cursor.state, p: cursor.position }));
}

export function decodeEdgeCursor(raw: string): EdgeCursor {
  const record = parseRecord(raw, INVALID_CURSOR);
  const state = record["s"];
  const position = record["p"];
  if (!isRole(state)) throw invalidArgument(INVALID_CURSOR);
  if (typeof position !== "number" || !Number.isInteger(position) || position < 0) {
    throw invalidArgument(INVALID_CURSOR);
  }
  return { state, position };
}

/**
 * 带 `state` 过滤时的守卫：游标里的 state 与请求里的过滤条件不一致 → 游标无效。
 * 上游原话是"也许调用方拿了一个改过过滤条件的旧游标"。
 */
export function assertCursorMatchesState(cursor: EdgeCursor, state: number | undefined): void {
  if (state !== undefined && cursor.state !== state) throw invalidArgument(INVALID_CURSOR);
}

export function encodeGroupListCursor(cursor: GroupListCursor): string {
  return toBase64Url(
    JSON.stringify({
      i: cursor.id,
      n: cursor.name,
      l: cursor.langTag,
      e: cursor.edgeCount,
      o: cursor.open,
      t: cursor.updateTime,
    }),
  );
}

export function decodeGroupListCursor(raw: string): GroupListCursor {
  const record = parseRecord(raw, MALFORMED_CURSOR);
  const id = record["i"];
  const name = record["n"];
  const langTag = record["l"];
  const edgeCount = record["e"];
  const open = record["o"];
  const updateTime = record["t"];
  if (typeof id !== "string" || id === "") throw invalidArgument(MALFORMED_CURSOR);
  if (typeof name !== "string" || typeof langTag !== "string") throw invalidArgument(MALFORMED_CURSOR);
  if (typeof edgeCount !== "number" || !Number.isInteger(edgeCount)) {
    throw invalidArgument(MALFORMED_CURSOR);
  }
  if (typeof open !== "boolean") throw invalidArgument(MALFORMED_CURSOR);
  if (typeof updateTime !== "number" || !Number.isInteger(updateTime)) {
    throw invalidArgument(MALFORMED_CURSOR);
  }
  return { id, name, langTag, edgeCount, open, updateTime };
}

function isRole(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4;
}

function parseRecord(raw: string, invalidMessage: string): Record<string, unknown> {
  if (raw.length > MAX_CURSOR_LENGTH) throw invalidArgument(invalidMessage);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(raw));
  } catch {
    throw invalidArgument(invalidMessage);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidArgument(invalidMessage);
  }
  return parsed as Record<string, unknown>;
}
