/**
 * 排行榜记录的 D1 访问层。
 *
 * 这里只有一类排序/比较：`(score, subscore, owner_id)` **三元组**。上游在列表、
 * 翻页、haystack 三处都用同一个元组，因为"同分同小分"是常态（比如一堆 0 分），
 * 只按 score 翻页会漏人也会重复。SQLite 支持行值比较 `(a,b,c) > (?,?,?)`，
 * 但为了让执行计划走得上 `leaderboard_record_list_idx`，这里展开成等价的
 * `a > ? OR (a = ? AND ...)` —— 语义相同，索引可用。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_leaderboard.go::LeaderboardRecordsList
 * 契约源: server/core_leaderboard.go::getLeaderboardRecordsHaystack
 */

export interface LeaderboardRecordRow {
  readonly leaderboard_id: string;
  readonly owner_id: string;
  readonly username: string | null;
  readonly score: number;
  readonly subscore: number;
  readonly num_score: number;
  readonly max_num_score: number;
  readonly metadata: string;
  readonly create_time: number;
  readonly update_time: number;
  readonly expiry_time: number;
}

export const RECORD_COLUMNS =
  "leaderboard_id, owner_id, username, score, subscore, num_score, max_num_score, " +
  "metadata, create_time, update_time, expiry_time";

/**
 * 库里的一行 + 名次。
 *
 * `ownerId` 与 `owner_id` 并存不是冗余：`owner_id` 是**库里那一列**（wire 层照抄
 * proto 原名），`ownerId` 是排名缓存要求字段名（`RankFillRecord`）——缓存是可替换的
 * 内部结构，不跟着 SQL 列的命名走。两个名字指向同一个值，由 `ranked()` 保证。
 */
export interface RankedRecord extends LeaderboardRecordRow {
  readonly ownerId: string;
  rank: number;
}

export function ranked(row: LeaderboardRecordRow, rank = 0): RankedRecord {
  return { ...row, ownerId: row.owner_id, rank };
}

export interface RecordTuple {
  readonly score: number;
  readonly subscore: number;
  readonly ownerId: string;
}

/** 参数累加器：`?N` 的编号与 `bind()` 的顺序必须一致，所以两者只能一起长。 */
class Binder {
  readonly values: unknown[] = [];

  push(value: unknown): string {
    this.values.push(value);
    return `?${this.values.length}`;
  }
}

/**
 * 展开后的元组比较：`(score, subscore, owner_id) OP (?, ?, ?)`。
 *
 * `ascending` 决定元组各列用升序还是降序比较——它与 ORDER BY 的方向是同一件事，
 * 上游把两者绑在一起（`>` 配 ASC，`<` 配 DESC），所以这里也做成一个参数。
 */
function tupleComparison(binder: Binder, tuple: RecordTuple, operator: ">" | "<"): string {
  const score = binder.push(tuple.score);
  const subscore = binder.push(tuple.subscore);
  const owner = binder.push(tuple.ownerId);
  return (
    `(score ${operator} ${score} OR (score = ${score} ` +
    `AND (subscore ${operator} ${subscore} OR (subscore = ${subscore} AND owner_id ${operator} ${owner}))))`
  );
}

function ownerFilter(binder: Binder, ownerIds: readonly string[]): string {
  const placeholders = ownerIds.map((ownerId) => binder.push(ownerId));
  return `owner_id IN (${placeholders.join(", ")})`;
}

export interface SelectRecordsOptions {
  /** 相对哪一条记录取（haystack 与翻页用）；不传就是"从头取"。 */
  readonly tuple?: RecordTuple;
  /** 与 `tuple` 配套的比较方向；`>` 必须与 `asc` 同用，`<` 与 `desc` 同用。 */
  readonly operator?: ">" | "<";
  /** 排序方向：`asc` = 分数小者在前，`desc` = 分数大者在前。 */
  readonly direction: "asc" | "desc";
  /** 取多少条；`0` 表示不限。 */
  readonly limit: number;
  /** 只取这些 owner 的记录（`GET /v2/leaderboard/{id}?owner_ids=`）。 */
  readonly ownerIds?: readonly string[];
}

export function selectRecords(
  db: D1Database,
  tenantId: string,
  leaderboardId: string,
  expiryTime: number,
  options: SelectRecordsOptions,
): Promise<D1Result<LeaderboardRecordRow>> {
  const binder = new Binder();
  const tenant = binder.push(tenantId);
  const board = binder.push(leaderboardId);
  const expiry = binder.push(expiryTime);
  let sql =
    `SELECT ${RECORD_COLUMNS} FROM leaderboard_record ` +
    `WHERE tenant_id = ${tenant} AND leaderboard_id = ${board} AND expiry_time = ${expiry}`;
  if (options.tuple !== undefined && options.operator !== undefined) {
    sql += ` AND ${tupleComparison(binder, options.tuple, options.operator)}`;
  }
  if (options.ownerIds !== undefined && options.ownerIds.length > 0) {
    sql += ` AND ${ownerFilter(binder, options.ownerIds)}`;
  }
  const descending = options.direction === "desc";
  sql += ` ORDER BY score ${descending ? "DESC" : "ASC"}, subscore ${
    descending ? "DESC" : "ASC"
  }, owner_id ${descending ? "DESC" : "ASC"}`;
  if (options.limit > 0) sql += ` LIMIT ${binder.push(options.limit)}`;
  return db
    .prepare(sql)
    .bind(...binder.values)
    .all<LeaderboardRecordRow>();
}

export function findRecord(
  db: D1Database,
  tenantId: string,
  leaderboardId: string,
  expiryTime: number,
  ownerId: string,
): Promise<LeaderboardRecordRow | null> {
  return db
    .prepare(
      `SELECT ${RECORD_COLUMNS} FROM leaderboard_record
       WHERE tenant_id = ?1 AND leaderboard_id = ?2 AND expiry_time = ?3 AND owner_id = ?4`,
    )
    .bind(tenantId, leaderboardId, expiryTime, ownerId)
    .first<LeaderboardRecordRow>();
}

export function deleteRecord(
  db: D1Database,
  tenantId: string,
  leaderboardId: string,
  expiryTime: number,
  ownerId: string,
): Promise<D1Result> {
  return db
    .prepare(
      `DELETE FROM leaderboard_record
       WHERE tenant_id = ?1 AND leaderboard_id = ?2 AND owner_id = ?3 AND expiry_time = ?4`,
    )
    .bind(tenantId, leaderboardId, ownerId, expiryTime)
    .run();
}

/** 排行榜上的入榜人数（`leaderboard.size`），只在"有名额上限"时才维护。 */
export function adjustLeaderboardSize(
  db: D1Database,
  tenantId: string,
  leaderboardId: string,
  delta: 1 | -1,
  guarded: boolean,
): Promise<D1Result> {
  const guard = guarded ? " AND (max_size = 0 OR size < max_size)" : "";
  const sign = delta === 1 ? "+" : "-";
  return db
    .prepare(
      `UPDATE leaderboard SET size = size ${sign} 1
       WHERE tenant_id = ?1 AND id = ?2${guard}`,
    )
    .bind(tenantId, leaderboardId)
    .run();
}
