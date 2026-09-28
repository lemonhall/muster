/**
 * 群组域的 D1 **读**语句（写全在 `edges.ts`，群组列表的九条排序在 `listing.ts`）。
 *
 * 三条纪律与身份/好友两层相同：每条 SQL 都带 `tenant_id`；状态一律以**上游的数字**
 * 出现在接口上（库里的布尔 `open` 在 SQL 里就换算回 `state`，不让上层去记这件事）；
 * 时间一律 Unix 秒。
 *
 * `open` → `state` 的换算是这里唯一"看起来多余"的一步：上游把 0/1 存在 `groups.state`，
 * 本项目存布尔列。换算只此一处（`OPEN_TO_STATE`），上层拿到的 `GroupRow` 与上游的
 * `api.Group` 同形，所以 `wire/group.ts` 不需要知道库里长什么样。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_group.go::getGroup
 * 契约源: server/core_group.go::groupCheckUserPermission
 * 契约源: server/core_group.go::ListGroupUsers
 * 契约源: server/core_group.go::ListUserGroups
 *
 * REQ-0001-012
 */

import type { EdgeCursor, GroupRow, GroupUserRow, UserGroupRow } from "./types";

/**
 * 群组列 + 把布尔 `open` 折回上游的 `state`。
 *
 * 上游是"0 开放 / 1 私有"，本项目是 `open = 1` 表示开放，所以私有 ⇔ `open = 0`。
 */
export const GROUP_COLUMNS = `g.id, g.creator_id, g.name, g.description, g.avatar_url,
       g.lang_tag, g.metadata, CASE WHEN g.open = 1 THEN 0 ELSE 1 END AS state,
       g.edge_count, g.max_count, g.create_time, g.update_time`;

/** 建群时把上游的 `state` 折成布尔：`state = 0`（开放）⇔ `open = 1`。 */
export function openOfState(state: number): number {
  return state === 0 ? 1 : 0;
}

export async function findGroupById(
  db: D1Database,
  tenantId: string,
  groupId: string,
): Promise<GroupRow | null> {
  return db
    .prepare(`SELECT ${GROUP_COLUMNS} FROM groups g WHERE g.tenant_id = ?1 AND g.id = ?2`)
    .bind(tenantId, groupId)
    .first<GroupRow>();
}

/** `SELECT name FROM groups WHERE id = ?`（上游 `AddGroupUsers` 那一句）。 */
export async function findGroupName(
  db: D1Database,
  tenantId: string,
  groupId: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT name FROM groups WHERE tenant_id = ?1 AND id = ?2")
    .bind(tenantId, groupId)
    .first<{ name: string }>();
  return row === null ? null : row.name;
}

/** 我在这群里的角色；没有边就是 `null`（上游 `sql.ErrNoRows` 那一支）。 */
export async function findEdgeState(
  db: D1Database,
  tenantId: string,
  groupId: string,
  userId: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      "SELECT state FROM group_edge WHERE tenant_id = ?1 AND source_id = ?2 AND destination_id = ?3",
    )
    .bind(tenantId, groupId, userId)
    .first<{ state: number }>();
  return row === null ? null : row.state;
}

const MEMBER_COLUMNS = `u.id, u.username, u.display_name, u.avatar_url, u.lang_tag,
       u.location, u.timezone, u.metadata, u.create_time, u.update_time,
       ge.state, ge.position`;

/**
 * 群成员列表。
 *
 * 不带 `state` 时上游会补一句 `AND ge.state >= 0 AND ge.state <= 3`：那不是过滤，
 * 是给查询分析器的提示（让它在 group_edge 主键上走区间扫描），但**副作用是封禁边
 * 被排除在外**——所以它确实改变了结果，本项目照抄。
 *
 * 游标比较是 `(source_id, state, position) >= (游标)`：`source_id` 已被 WHERE 固定，
 * 语义上就是 `(state, position) >= 游标`，游标指向**下一页第一行**（含）。
 */
export async function listMemberRows(
  db: D1Database,
  tenantId: string,
  groupId: string,
  limit: number,
  state: number | undefined,
  cursor: EdgeCursor | null,
): Promise<GroupUserRow[]> {
  const params: unknown[] = [tenantId, groupId];
  let sql = `SELECT ${MEMBER_COLUMNS}
    FROM users u, group_edge ge
    WHERE u.tenant_id = ?1 AND u.id = ge.destination_id
      AND ge.tenant_id = ?1 AND ge.source_id = ?2`;
  if (state !== undefined) {
    sql += ` AND ge.state = ?${push(params, state)}`;
  } else {
    sql += " AND ge.state >= 0 AND ge.state <= 3";
  }
  if (cursor !== null) {
    const first = push(params, cursor.state);
    const second = push(params, cursor.position);
    sql += ` AND (ge.state, ge.position) >= (?${first}, ?${second})`;
  }
  sql += " ORDER BY ge.state ASC, ge.position ASC";
  sql += ` LIMIT ?${push(params, limit + 1)}`;
  const result = await db.prepare(sql).bind(...params).all<GroupUserRow>();
  return result.results;
}

/** 用户群组列表的一行：群 + 我的角色。`ge.source_id` 是**用户**（双向边的另一半）。 */
export async function listUserGroupRows(
  db: D1Database,
  tenantId: string,
  userId: string,
  limit: number,
  state: number | undefined,
  cursor: EdgeCursor | null,
): Promise<UserGroupRow[]> {
  const params: unknown[] = [tenantId, userId];
  let sql = `SELECT ${GROUP_COLUMNS}, ge.state AS user_state, ge.position
    FROM groups g, group_edge ge
    WHERE g.tenant_id = ?1 AND g.id = ge.destination_id
      AND ge.tenant_id = ?1 AND ge.source_id = ?2`;
  if (state !== undefined) {
    sql += ` AND ge.state = ?${push(params, state)}`;
  } else {
    sql += " AND ge.state >= 0 AND ge.state <= 3";
  }
  if (cursor !== null) {
    const first = push(params, cursor.state);
    const second = push(params, cursor.position);
    sql += ` AND (ge.state, ge.position) >= (?${first}, ?${second})`;
  }
  sql += " ORDER BY ge.state ASC, ge.position ASC";
  sql += ` LIMIT ?${push(params, limit + 1)}`;
  const result = await db.prepare(sql).bind(...params).all<UserGroupRow>();
  return result.results;
}

/**
 * "除我之外，这群里各状态各有几人"（上游 `LeaveGroup` 里那条 `GROUP BY state`）。
 *
 * 上游只统计 SUPERADMIN / ADMIN / MEMBER 三种（`switch` 里连着三个 case，前两个
 * `fallthrough` 到 MEMBER）；JOIN_REQUEST 与 BANNED 都不计入"还有别人"。返回的
 * 两个数就是那一段的全部输入。
 */
export interface OtherMemberCounts {
  readonly otherSuperadmins: number;
  readonly otherMembers: number;
}

export async function countOtherMembers(
  db: D1Database,
  tenantId: string,
  groupId: string,
  userId: string,
): Promise<OtherMemberCounts> {
  const result = await db
    .prepare(
      `SELECT state AS state, COUNT(destination_id) AS count FROM group_edge
       WHERE tenant_id = ?1 AND source_id = ?2 AND destination_id <> ?3
         AND state >= 0 AND state <= 2
       GROUP BY state`,
    )
    .bind(tenantId, groupId, userId)
    .all<{ state: number; count: number }>();
  let otherSuperadmins = 0;
  let otherMembers = 0;
  for (const row of result.results) {
    if (row.state === 0) otherSuperadmins += row.count;
    otherMembers += row.count;
  }
  return { otherSuperadmins, otherMembers };
}

export async function userExists(db: D1Database, tenantId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS present FROM users WHERE tenant_id = ?1 AND id = ?2")
    .bind(tenantId, userId)
    .first<{ present: number }>();
  return row !== null;
}

export async function findUsername(
  db: D1Database,
  tenantId: string,
  userId: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT username FROM users WHERE tenant_id = ?1 AND id = ?2")
    .bind(tenantId, userId)
    .first<{ username: string }>();
  return row === null ? null : row.username;
}

export async function findUsernames(
  db: D1Database,
  tenantId: string,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const params: unknown[] = [tenantId];
  const placeholders = userIds.map((id) => `?${push(params, id)}`).join(", ");
  const result = await db
    .prepare(`SELECT id, username FROM users WHERE tenant_id = ?1 AND id IN (${placeholders})`)
    .bind(...params)
    .all<{ id: string; username: string }>();
  return new Map(result.results.map((row) => [row.id, row.username]));
}

function push(params: unknown[], value: unknown): number {
  params.push(value);
  return params.length;
}
