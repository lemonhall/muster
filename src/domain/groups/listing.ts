/**
 * 三条"列一群东西"的读路径：群成员、某人的群、群目录。
 *
 * 共同的分页语义（与好友列表同构，来自上游 `edgeListCursor` / `groupConvertRows`）：
 * 多取一行（`limit + 1`），多出来的那一行**不返回**，只用来生成游标；游标指向
 * 下一页第一行（含）——所以"最后一行正好等于游标"时不会被跳过，也不会重来。
 *
 * 三条各自的可观察细节：
 *   - 群成员与用户群组：游标是 `(state, position)`，带 `state` 过滤时游标里的 state
 *     必须与过滤条件一致，否则 `Cursor is invalid.`；
 *   - 群目录：默认 `limit` 是 **1**（不是 100）；`name` 与其它过滤条件互斥，违反时报
 *     `name filter cannot be combined with any other filter`；游标编码坏掉时报
 *     `Malformed cursor was used.`（与上面那句**不同**，见 `cursor.ts` 的说明）。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_group.go::ListGroupUsers
 * 契约源: server/api_group.go::ListUserGroups
 * 契约源: server/api_group.go::ListGroups
 * 契约源: server/core_group.go::ListGroups
 *
 * REQ-0001-012
 */

import { invalidArgument } from "../../http/errors";
import {
  assertCursorMatchesState,
  decodeEdgeCursor,
  decodeGroupListCursor,
  encodeEdgeCursor,
  encodeGroupListCursor,
} from "./cursor";
import { buildGroupListQuery } from "./group-list-query";
import { listMemberRows, listUserGroupRows } from "./store";
import { GROUP_STATE, type GroupListCursor, type GroupRow, type GroupUserRow, type UserGroupRow } from "./types";

export const DEFAULT_GROUP_USER_LIMIT = 100;
export const MAX_GROUP_USER_LIMIT = 100;
/** 上游 `ApiServer.ListGroups` 的默认值就是 1——不给 `limit` 只回一个群。 */
export const DEFAULT_GROUP_LIMIT = 1;
export const MAX_GROUP_LIMIT = 100;

const LIMIT_RANGE_ERROR = "Invalid limit - limit must be between 1 and 100.";
const STATE_RANGE_ERROR = "Invalid state - state must be between 0 and 4.";

export interface GroupUserListResult {
  readonly groupUsers: readonly GroupUserRow[];
  readonly cursor: string;
}

export interface UserGroupListResult {
  readonly userGroups: readonly UserGroupRow[];
  readonly cursor: string;
}

export interface GroupListResult {
  readonly groups: readonly GroupRow[];
  readonly cursor: string;
}

export interface ListGroupUsersInput {
  readonly limit?: number | undefined;
  readonly state?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface ListUserGroupsInput {
  readonly limit?: number | undefined;
  readonly state?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface ListGroupsInput {
  readonly name?: string | undefined;
  readonly langTag?: string | undefined;
  readonly open?: boolean | undefined;
  readonly members?: number | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

function validateLimit(limit: number): void {
  if (limit < 1 || limit > MAX_GROUP_USER_LIMIT) throw invalidArgument(LIMIT_RANGE_ERROR);
}

function validateState(state: number | undefined): void {
  if (state !== undefined && (state < 0 || state > 4)) throw invalidArgument(STATE_RANGE_ERROR);
}

/** 成员列表与用户群组列表共用的前半段：校验 → 解游标 → 对齐过滤条件。 */
function prepareEdgeCursor(state: number | undefined, raw: string): ReturnType<typeof decodeEdgeCursor> | null {
  if (raw === "") return null;
  const cursor = decodeEdgeCursor(raw);
  assertCursorMatchesState(cursor, state);
  return cursor;
}

export async function listGroupUsers(
  db: D1Database,
  tenantId: string,
  groupId: string,
  input: ListGroupUsersInput,
): Promise<GroupUserListResult> {
  const limit = input.limit ?? DEFAULT_GROUP_USER_LIMIT;
  validateLimit(limit);
  const state = input.state;
  validateState(state);

  const cursor = prepareEdgeCursor(state, input.cursor ?? "");
  const rows = await listMemberRows(db, tenantId, groupId, limit, state, cursor);
  const page = rows.slice(0, limit);
  const next = rows[limit];
  return {
    groupUsers: page,
    cursor: next === undefined ? "" : encodeEdgeCursor({ state: next.state, position: next.position }),
  };
}

export async function listUserGroups(
  db: D1Database,
  tenantId: string,
  userId: string,
  input: ListUserGroupsInput,
): Promise<UserGroupListResult> {
  const limit = input.limit ?? DEFAULT_GROUP_USER_LIMIT;
  validateLimit(limit);
  const state = input.state;
  validateState(state);

  const cursor = prepareEdgeCursor(state, input.cursor ?? "");
  const rows = await listUserGroupRows(db, tenantId, userId, limit, state, cursor);
  const page = rows.slice(0, limit);
  const next = rows[limit];
  return {
    userGroups: page,
    cursor: next === undefined ? "" : encodeEdgeCursor({ state: next.user_state, position: next.position }),
  };
}

/** 群行 → 群目录游标（字段全填：编码格式对所有分支是同一个形状）。 */
function groupCursor(row: GroupRow): string {
  return encodeGroupListCursor({
    id: row.id,
    name: row.name,
    langTag: row.lang_tag,
    edgeCount: row.edge_count,
    open: row.state === GROUP_STATE.open,
    updateTime: row.update_time,
  });
}

export async function listGroups(
  db: D1Database,
  tenantId: string,
  input: ListGroupsInput,
): Promise<GroupListResult> {
  const rawName = input.name ?? "";
  const langTag = input.langTag ?? "";
  const members = input.members ?? -1;

  if (rawName !== "" && (langTag !== "" || input.open !== undefined || members > -1)) {
    throw invalidArgument("name filter cannot be combined with any other filter");
  }

  const limit = input.limit ?? DEFAULT_GROUP_LIMIT;
  validateLimit(limit);

  const rawCursor = input.cursor ?? "";
  const cursor: GroupListCursor | null = rawCursor === "" ? null : decodeGroupListCursor(rawCursor);
  const name = rawName.replace(/^[% ]+/u, "");

  const query = buildGroupListQuery({
    tenantId,
    name,
    langTag,
    open: input.open,
    edgeCount: members,
    limit,
    cursor,
  });
  const result = await db.prepare(query.sql).bind(...query.params).all<GroupRow>();
  const rows = result.results;
  const page = rows.slice(0, limit);
  const next = rows[limit];
  return { groups: page, cursor: next === undefined ? "" : groupCursor(page[page.length - 1] as GroupRow) };
}
