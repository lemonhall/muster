/**
 * 排行榜定义与记录的 D1 访问层。
 *
 * 三条纪律：
 *   1. 每条 SQL 都带 `tenant_id`（ECN-0001）；
 *   2. 排序与游标比较一律用 `(score, subscore, owner_id)` **三元组**，与上游同序，
 *      这样"同分同小分"的并列不会在翻页时漏人也不会重复；
 *   3. 写记录用 `ON CONFLICT (tenant_id, owner_id, leaderboard_id, expiry_time)`，
 *      冲突键就是上游的 `(owner_id, leaderboard_id, expiry_time)`（多一个租户列）。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_leaderboard.go::LeaderboardRecordsList
 * 契约源: server/core_leaderboard.go::LeaderboardRecordWrite
 * 契约源: server/core_leaderboard.go::LeaderboardRecordDelete
 */

import type { LeaderboardRow } from "./definition";

export const LEADERBOARD_COLUMNS = [
  "id",
  "authoritative",
  "sort_order",
  "operator",
  "reset_schedule",
  "metadata",
  "create_time",
  "title",
  "description",
  "category",
  "start_time",
  "end_time",
  "duration",
  "max_size",
  "max_num_score",
  "join_required",
  "enable_ranks",
  "size",
].join(", ");

export function insertLeaderboard(
  db: D1Database,
  tenantId: string,
  row: LeaderboardRow,
): Promise<D1Result> {
  return db
    .prepare(
      `INSERT INTO leaderboard (tenant_id, id, authoritative, sort_order, operator, reset_schedule,
         metadata, create_time, title, description, category, start_time, end_time, duration,
         max_size, max_num_score, join_required, enable_ranks, size)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`,
    )
    .bind(
      tenantId,
      row.id,
      row.authoritative,
      row.sort_order,
      row.operator,
      row.reset_schedule,
      row.metadata,
      row.create_time,
      row.title,
      row.description,
      row.category,
      row.start_time,
      row.end_time,
      row.duration,
      row.max_size,
      row.max_num_score,
      row.join_required,
      row.enable_ranks,
      row.size,
    )
    .run();
}

export function findLeaderboard(
  db: D1Database,
  tenantId: string,
  id: string,
): Promise<LeaderboardRow | null> {
  return db
    .prepare(`SELECT ${LEADERBOARD_COLUMNS} FROM leaderboard WHERE tenant_id = ?1 AND id = ?2`)
    .bind(tenantId, id)
    .first<LeaderboardRow>();
}

export interface TournamentListFilters {
  readonly categoryStart: number;
  readonly categoryEnd: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly limit: number;
  readonly now: number;
  /** 上一页最后一条的 `(create_time, id)`；空串表示从头发。 */
  readonly cursor: { readonly createTime: number; readonly id: string } | null;
}

/**
 * 锦标赛目录：分类区间 + 起止时间过滤（对应 `GET /v2/tournament`）。
 *
 * `endTime` 的三个取值各有确定含义，是上游 `ListTournaments` 里最难照抄的一段：
 *   - `-1`（默认）：只看"还在进行或还没结束"的——`end_time = 0` 或 `end_time >= now`；
 *   - `0`：只看**没有**结束时间的；
 *   - `> 0`：`end_time` 必须存在且不晚于它。
 * 写成 `end_time <= ?` 一条比较就会把 `-1` 与 `0` 混成一件事，这是这一段的坑。
 *
 * 契约源（机器可读）：
 * 契约源: server/leaderboard_cache.go::LocalLeaderboardCache.ListTournaments
 */
export async function listTournamentRows(
  db: D1Database,
  tenantId: string,
  filters: TournamentListFilters,
): Promise<LeaderboardRow[]> {
  const params: unknown[] = [tenantId, filters.categoryStart, filters.categoryEnd];
  const push = (value: unknown): string => {
    params.push(value);
    return `?${params.length}`;
  };
  let sql = `SELECT ${LEADERBOARD_COLUMNS} FROM leaderboard
    WHERE tenant_id = ?1 AND duration != 0 AND category >= ?2 AND category <= ?3`;
  if (filters.startTime >= 0) sql += ` AND start_time >= ${push(filters.startTime)}`;
  if (filters.endTime === 0) {
    sql += " AND end_time = 0";
  } else if (filters.endTime === -1) {
    sql += ` AND (end_time = 0 OR end_time >= ${push(filters.now)})`;
  } else {
    sql += ` AND end_time != 0 AND end_time <= ${push(filters.endTime)}`;
  }
  if (filters.cursor !== null) {
    const createTime = push(filters.cursor.createTime);
    const id = push(filters.cursor.id);
    sql += ` AND (create_time > ${createTime} OR (create_time = ${createTime} AND id > ${id}))`;
  }
  sql += ` ORDER BY create_time ASC, id ASC LIMIT ${push(filters.limit + 1)}`;
  const result = await db.prepare(sql).bind(...params).all<LeaderboardRow>();
  return result.results;
}

/** 调度器要看的全部定义（只有 id / 时间 / 重置表达式有用）。 */
export async function listAllLeaderboards(db: D1Database, tenantId: string): Promise<LeaderboardRow[]> {
  const result = await db
    .prepare(`SELECT ${LEADERBOARD_COLUMNS} FROM leaderboard WHERE tenant_id = ?1 ORDER BY id`)
    .bind(tenantId)
    .all<LeaderboardRow>();
  return result.results;
}

export function setLeaderboardRanksEnabled(
  db: D1Database,
  tenantId: string,
  id: string,
  enabled: boolean,
): Promise<D1Result> {
  return db
    .prepare("UPDATE leaderboard SET enable_ranks = ?1 WHERE tenant_id = ?2 AND id = ?3")
    .bind(enabled ? 1 : 0, tenantId, id)
    .run();
}
