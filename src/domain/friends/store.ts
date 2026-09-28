/**
 * 好友边的 D1 访问层。
 *
 * 本文件只放**读**语句；写语句（接受邀请、建边、删边、拉黑、计数）在 `edges.ts`。
 * 分开的理由很实际：写的每一条都有"改到几行才算成功"的判据，和读的取数逻辑混在一起
 * 会让状态机难以单独审阅。
 *
 * 纪律与身份/存储两层相同：**每一条 SQL 都带 `tenant_id` 条件**，上层拿不到
 * 不带租户的查询方法（ECN-0001）。
 *
 * `position` 是"关系建立时刻"的序号。上游用的是 `time.Now().UnixNano()`（并靠它
 * 判断"这条关系是不是刚建的"）；本项目用一个**每租户单调递增**的计数代替：
 * 纳秒时间戳超过 JS 的安全整数范围（1.7e18 > 2^53），放进游标会静默丢精度，
 * 而那个精度恰好是分页定位要用的。单调计数与纳秒时间戳在"序号越大越新"这一点上等价。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_friend.go::ListFriends
 * 契约源: server/core_friend.go::ListFriendsOfFriends
 * 契约源: server/core_friend.go::addFriend
 * 契约源: server/core_friend.go::deleteFriend
 * 契约源: server/core_friend.go::blockFriend
 *
 * REQ-0001-011
 */

import type { FriendRow, FriendsOfFriendsPair, UserProfileRow } from "./types";

const USER_COLUMNS = [
  "u.id",
  "u.username",
  "u.display_name",
  "u.avatar_url",
  "u.lang_tag",
  "u.location",
  "u.timezone",
  "u.metadata",
  "u.create_time",
  "u.update_time",
].join(", ");

const FRIEND_SELECT = `
SELECT ${USER_COLUMNS},
       e.state, e.position, e.update_time AS edge_update_time, e.metadata AS edge_metadata
FROM user_edge e
JOIN users u ON u.tenant_id = e.tenant_id AND u.id = e.destination_id
WHERE e.tenant_id = ?1 AND e.source_id = ?2`;

export async function listFriendRows(
  db: D1Database,
  tenantId: string,
  userId: string,
  limit: number,
  state: number | undefined,
  cursor: { readonly state: number; readonly position: number } | null,
): Promise<FriendRow[]> {
  const params: unknown[] = [tenantId, userId];
  let sql = FRIEND_SELECT;
  if (state !== undefined) sql += ` AND e.state = ?${push(params, state)}`;
  if (cursor !== null) {
    const first = push(params, cursor.state);
    const second = push(params, cursor.position);
    sql += ` AND (e.state, e.position) >= (?${first}, ?${second})`;
  }
  sql += " ORDER BY e.state ASC, e.position ASC";
  sql += ` LIMIT ?${push(params, limit + 1)}`;
  const result = await db.prepare(sql).bind(...params).all<FriendRow>();
  return result.results;
}

/** 上游 `ListFriendsOfFriends` 的第一步："抓全部好友（state = 0）"。 */
export async function findFriendIds(db: D1Database, tenantId: string, userId: string): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT destination_id FROM user_edge
       WHERE tenant_id = ?1 AND source_id = ?2 AND state = 0
       ORDER BY destination_id`,
    )
    .bind(tenantId, userId)
    .all<{ destination_id: string }>();
  return result.results.map((row) => row.destination_id);
}

/**
 * 一个好友的"好友的好友"（排除自己、排除已经在我的好友表里的人）。
 *
 * 上游用的是 `destination_id != ALL($3::UUID[])`；SQLite 没有数组，这里展开成
 * 一个 `NOT IN (?, ?, ...)`。好友数量大到超过 SQLite 的变量上限时会退化成
 * "排除不掉"——好友数远超上限的个人账号在本项目里不存在（上游同样有 65535 的上限）。
 */
export async function listFriendsOfFriendRows(
  db: D1Database,
  tenantId: string,
  friendId: string,
  userId: string,
  excludeIds: readonly string[],
  limit: number,
  cursor: { readonly sourceId: string; readonly destinationId: string } | null,
): Promise<FriendsOfFriendsPair[]> {
  const params: unknown[] = [tenantId, friendId, userId];
  let sql = `SELECT e.source_id, e.destination_id FROM user_edge e
    WHERE e.tenant_id = ?1 AND e.source_id = ?2 AND e.destination_id <> ?3 AND e.state = 0`;
  if (excludeIds.length > 0) {
    const placeholders = excludeIds.map((id) => `?${push(params, id)}`).join(", ");
    sql += ` AND e.destination_id NOT IN (${placeholders})`;
  }
  if (cursor !== null) {
    const first = push(params, cursor.sourceId);
    const second = push(params, cursor.destinationId);
    sql += ` AND (e.source_id, e.destination_id) >= (?${first}, ?${second})`;
  }
  sql += " ORDER BY e.source_id, e.destination_id";
  sql += ` LIMIT ?${push(params, limit)}`;
  const result = await db.prepare(sql).bind(...params).all<{ source_id: string; destination_id: string }>();
  return result.results.map((row) => ({ referrer: row.source_id, friendId: row.destination_id }));
}

export async function findUserProfiles(
  db: D1Database,
  tenantId: string,
  ids: readonly string[],
): Promise<UserProfileRow[]> {
  if (ids.length === 0) return [];
  const params: unknown[] = [tenantId];
  const placeholders = ids.map((id) => `?${push(params, id)}`).join(", ");
  const result = await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.tenant_id = ?1 AND u.id IN (${placeholders})`)
    .bind(...params)
    .all<UserProfileRow>();
  return result.results;
}

export async function findEdgeState(
  db: D1Database,
  tenantId: string,
  sourceId: string,
  destinationId: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      "SELECT state FROM user_edge WHERE tenant_id = ?1 AND source_id = ?2 AND destination_id = ?3",
    )
    .bind(tenantId, sourceId, destinationId)
    .first<{ state: number }>();
  return row === null ? null : row.state;
}

/** 下一序号：`MAX(position) + 1`（同一租户内单调递增，见文件头说明）。 */
export async function nextPosition(db: D1Database, tenantId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM user_edge WHERE tenant_id = ?1")
    .bind(tenantId)
    .first<{ next: number }>();
  return row?.next ?? 1;
}

/** 取用户 id：账号不存在时上游那句 `Invalid user ID '<id>'.` 由调用方决定，这里只回事实。 */
export async function userExists(db: D1Database, tenantId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS present FROM users WHERE tenant_id = ?1 AND id = ?2")
    .bind(tenantId, userId)
    .first<{ present: number }>();
  return row !== null;
}

function push(params: unknown[], value: unknown): number {
  params.push(value);
  return params.length;
}
