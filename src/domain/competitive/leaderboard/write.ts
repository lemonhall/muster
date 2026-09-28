/**
 * 排行榜记录的写入、删除，以及"关掉名次"。
 *
 * 写入的全部难点集中在一条 SQL 上：`INSERT ... ON CONFLICT DO UPDATE ... WHERE`。
 *
 *  - `ON CONFLICT` 的目标是主键 `(tenant_id, owner_id, leaderboard_id, expiry_time)`，
 *    于是"同一期里同一人只有一条记录"由库保证，不需要先查后写；
 *  - `DO UPDATE ... WHERE <过滤>` 是 operator 语义的落点：**新值不比旧值好就不更新**。
 *    过滤条件不成立时这条语句一行都不返回，于是"记录没变"这件事可以被
 *    `RETURNING` 的返回值直接观察到，不必先读一遍再比对；
 *  - `num_score` 每次真正更新时 +1（首次插入为 1，与上游列默认值一致），它同时
 *    充当排名缓存的世代号。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_leaderboard.go::LeaderboardRecordWrite
 * 契约源: server/core_leaderboard.go::LeaderboardRecordDelete
 * 契约源: server/core_leaderboard.go::disableLeaderboardRanks
 */

import { ApiOperator, LeaderboardOperator, SortOrder, type Leaderboard } from "./definition";
import { getRank, forgetRank, forgetBoard, insertRank } from "./cache";
import { competitiveError } from "../errors";
import {
  RECORD_COLUMNS,
  deleteRecord,
  findRecord,
  ranked,
  type LeaderboardRecordRow,
  type RankedRecord,
} from "./record-store";

export interface LeaderboardRecordWriteInput {
  /** `""` 表示权威调用者（上游的 `uuid.Nil`）：只有它能写 `authoritative` 的榜。 */
  readonly callerId: string;
  readonly ownerId: string;
  readonly username: string;
  readonly score: number;
  readonly subscore: number;
  /** 已经是合法 JSON 文本（端点层校验过），空串表示"不动 metadata"。 */
  readonly metadata: string;
  /** `api.Operator` 的数值；`Operator.NoOverride` 表示用榜单自己的 operator。 */
  readonly overrideOperator: number;
}

/** 写入这一期的 expiry：普通榜看重置表达式，没有重置就是 `0`（永不作废）。 */
export function writeExpiry(leaderboard: Leaderboard, now: Date): number {
  if (leaderboard.resetSchedule === null) return 0;
  return Math.floor(leaderboard.resetSchedule.next(now).getTime() / 1000);
}

function resolveOperator(leaderboard: Leaderboard, override: number): number {
  if (override === ApiOperator.NoOverride) return leaderboard.operator;
  // `api.Operator` 的 1..4 正好对应内部 operator 的 0..3（BEST/SET/INCREMENT/DECREMENT）。
  if (override >= 1 && override <= 4) return override - 1;
  throw competitiveError("invalid-operator");
}

interface Assignment {
  /** `DO UPDATE SET` 里的分数表达式（列名带表前缀，与上游同一形状）。 */
  readonly opSql: string;
  /** 过滤：不成立就"记录没变"。 */
  readonly filterSql: string;
  /** 首次插入时写进 `score` / `subscore` 的值。 */
  readonly insertScore: number;
  readonly insertSubscore: number;
}

function assignmentFor(
  leaderboard: Leaderboard,
  operator: number,
  score: number,
  subscore: number,
): Assignment {
  const ascending = leaderboard.sortOrder === SortOrder.Ascending;
  switch (operator) {
    case LeaderboardOperator.Increment:
      return {
        opSql: "score = leaderboard_record.score + ?4, subscore = leaderboard_record.subscore + ?5",
        filterSql: "?4 <> 0 OR ?5 <> 0",
        insertScore: score,
        insertSubscore: subscore,
      };
    case LeaderboardOperator.Decrement:
      return {
        opSql:
          "score = MAX(leaderboard_record.score - ?4, 0), " +
          "subscore = MAX(leaderboard_record.subscore - ?5, 0)",
        filterSql: "?4 <> 0 OR ?5 <> 0",
        // 上游首次插入时写入 0：扣分榜上"还没得分"就是 0，不是一个负数起点。
        insertScore: 0,
        insertSubscore: 0,
      };
    case LeaderboardOperator.Set:
      return {
        opSql: "score = ?4, subscore = ?5",
        filterSql: "leaderboard_record.score <> ?4 OR leaderboard_record.subscore <> ?5",
        insertScore: score,
        insertSubscore: subscore,
      };
    default:
      // BEST：升序榜越小越好，降序榜越大越好。
      return ascending
        ? {
            opSql:
              "score = MIN(leaderboard_record.score, ?4), " +
              "subscore = MIN(leaderboard_record.subscore, ?5)",
            filterSql: "leaderboard_record.score > ?4 OR leaderboard_record.subscore > ?5",
            insertScore: score,
            insertSubscore: subscore,
          }
        : {
            opSql:
              "score = MAX(leaderboard_record.score, ?4), " +
              "subscore = MAX(leaderboard_record.subscore, ?5)",
            filterSql: "leaderboard_record.score < ?4 OR leaderboard_record.subscore < ?5",
            insertScore: score,
            insertSubscore: subscore,
          };
  }
}

export async function leaderboardRecordWrite(
  db: D1Database,
  tenantId: string,
  leaderboard: Leaderboard,
  input: LeaderboardRecordWriteInput,
  now: Date,
): Promise<RankedRecord> {
  if (leaderboard.authoritative && input.callerId !== "") {
    throw competitiveError("authoritative");
  }
  const operator = resolveOperator(leaderboard, input.overrideOperator);
  const assignment = assignmentFor(leaderboard, operator, input.score, input.subscore);
  const expiryTime = writeExpiry(leaderboard, now);
  const nowSec = Math.floor(now.getTime() / 1000);

  const sql =
    `INSERT INTO leaderboard_record
       (tenant_id, leaderboard_id, owner_id, username, score, subscore, metadata,
        expiry_time, num_score, max_num_score, create_time, update_time)
     VALUES (?1, ?2, ?3, ?6, ?7, ?8, COALESCE(?9, '{}'), ?10, 1, ?11, ?12, ?12)
     ON CONFLICT (tenant_id, owner_id, leaderboard_id, expiry_time)
     DO UPDATE SET
       ${assignment.opSql},
       num_score = leaderboard_record.num_score + 1,
       metadata = COALESCE(?9, leaderboard_record.metadata),
       username = COALESCE(?6, leaderboard_record.username),
       update_time = ?12
     WHERE ${assignment.filterSql}
     RETURNING ${RECORD_COLUMNS}`;
  const write = await db
    .prepare(sql)
    .bind(
      tenantId,
      leaderboard.id,
      input.ownerId,
      input.score,
      input.subscore,
      input.username === "" ? null : input.username,
      assignment.insertScore,
      assignment.insertSubscore,
      input.metadata === "" ? null : input.metadata,
      expiryTime,
      leaderboard.maxNumScore,
      nowSec,
    )
    .first<LeaderboardRecordRow>();

  // 一行都没返回 = 记录本来就在，且新值不比旧值好。这时读回旧记录、并把它的名次
  // 从缓存里取出来——**不能**重新插入缓存，那会把它当成一次新的提交。
  const row =
    write ??
    (await findRecord(db, tenantId, leaderboard.id, expiryTime, input.ownerId));
  if (row === null) {
    throw competitiveError("not-found");
  }
  const record = ranked(row);
  record.rank =
    write === null
      ? getRank(leaderboard, expiryTime, input.ownerId)
      : insertRank(
          leaderboard,
          expiryTime,
          input.ownerId,
          row.score,
          row.subscore,
          row.num_score,
        );
  return record;
}

export async function leaderboardRecordDelete(
  db: D1Database,
  tenantId: string,
  leaderboard: Leaderboard,
  callerId: string,
  ownerId: string,
  now: Date,
): Promise<void> {
  if (leaderboard.isTournament) throw competitiveError("not-found");
  if (leaderboard.authoritative && callerId !== "") throw competitiveError("authoritative");
  const expiryTime = writeExpiry(leaderboard, now);
  await deleteRecord(db, tenantId, leaderboard.id, expiryTime, ownerId);
  forgetRank(leaderboard.id, expiryTime, ownerId);
}

/** 关掉名次：库里 `enable_ranks = 0`，并把这一期的名次缓存整块丢掉。 */
export async function disableLeaderboardRanks(
  db: D1Database,
  tenantId: string,
  leaderboard: Leaderboard,
  now: Date,
): Promise<void> {
  if (leaderboard.isTournament) throw competitiveError("not-found");
  await db
    .prepare("UPDATE leaderboard SET enable_ranks = 0 WHERE tenant_id = ?1 AND id = ?2")
    .bind(tenantId, leaderboard.id)
    .run();
  forgetBoard(leaderboard.id, writeExpiry(leaderboard, now));
}
