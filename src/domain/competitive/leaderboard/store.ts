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

/** 锦标赛目录：分类区间 + 起止时间过滤，按 id 升序（对应 `GET /v2/tournament`）。 */
export async function listTournamentRows(
  db: D1Database,
  tenantId: string,
  filters: {
    readonly categoryStart: number;
    readonly categoryEnd: number;
    readonly startTime: number;
    readonly endTime: number;
    readonly limit: number;
    readonly cursorId: string;
  },
): Promise<LeaderboardRow[]> {
  const params: unknown[] = [tenantId, filters.categoryStart, filters.categoryEnd];
  let sql = `SELECT ${LEADERBOARD_COLUMNS} FROM leaderboard
    WHERE tenant_id = ?1 AND duration != 0 AND category >= ?2 AND category <= ?3`;
  if (filters.startTime >= 0) {
    params.push(filters.startTime);
    sql += ` AND start_time >= ?${params.length}`;
  }
  if (filters.endTime >= 0) {
    params.push(filters.endTime);
    sql += ` AND start_time <= ?${params.length}`;
  }
  if (filters.cursorId !== "") {
    params.push(filters.cursorId);
    sql += ` AND id > ?${params.length}`;
  }
  params.push(filters.limit + 1);
  sql += ` ORDER BY id ASC LIMIT ?${params.length}`;
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
