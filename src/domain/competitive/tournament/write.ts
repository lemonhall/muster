/**
 * 锦标赛的写分与删分。
 *
 * 与普通排行榜最大的差别是：**锦标赛不做"新值更好才更新"的过滤**。
 * 上游锦标赛的 `ON CONFLICT DO UPDATE` 没有 `WHERE`，所以每一次提交都会
 * `num_score + 1`——`max_num_score`（允许提交几次）正是靠这个计数来判的。
 *
 * 另一处差别是 `join_required`：要求加入的锦标赛只能**更新**已存在的报名记录，
 * 没有记录就是 `Must join tournament before attempting to write value.`。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_tournament.go::TournamentRecordWrite
 * 契约源: server/core_tournament.go::TournamentRecordDelete
 */

import { ApiOperator, LeaderboardOperator, SortOrder, type Leaderboard } from "../leaderboard/definition";
import { competitiveError } from "../errors";
import { forgetRank, insertRank } from "../leaderboard/cache";
import {
  RECORD_COLUMNS,
  adjustLeaderboardSize,
  deleteRecord,
  findRecord,
  ranked,
  type LeaderboardRecordRow,
  type RankedRecord,
} from "../leaderboard/record-store";
import { calculateTournamentDeadlines } from "./deadlines";
import type { LeaderboardRecordWriteInput } from "../leaderboard/write";

function resolveOperator(leaderboard: Leaderboard, override: number): number {
  if (override === ApiOperator.NoOverride) return leaderboard.operator;
  if (override >= ApiOperator.Best && override <= ApiOperator.Decrement) return override - 1;
  throw competitiveError("invalid-operator");
}

/** `DO UPDATE SET` 的分数表达式；`?5` / `?6` 是这次提交的分数与小分。 */
function scoreSql(leaderboard: Leaderboard, operator: number): string {
  switch (operator) {
    case LeaderboardOperator.Increment:
      return "score = leaderboard_record.score + ?5, subscore = leaderboard_record.subscore + ?6";
    case LeaderboardOperator.Decrement:
      return (
        "score = MAX(leaderboard_record.score - ?5, 0), " +
        "subscore = MAX(leaderboard_record.subscore - ?6, 0)"
      );
    case LeaderboardOperator.Set:
      return "score = ?5, subscore = ?6";
    default:
      return leaderboard.sortOrder === SortOrder.Ascending
        ? "score = MIN(leaderboard_record.score, ?5), subscore = MIN(leaderboard_record.subscore, ?6)"
        : "score = MAX(leaderboard_record.score, ?5), subscore = MAX(leaderboard_record.subscore, ?6)";
  }
}

export async function tournamentRecordWrite(
  db: D1Database,
  tenantId: string,
  leaderboard: Leaderboard | null,
  input: LeaderboardRecordWriteInput,
  now: Date,
): Promise<RankedRecord> {
  if (leaderboard === null || !leaderboard.isTournament) throw competitiveError("not-tournament");
  if (leaderboard.authoritative && input.callerId !== "") throw competitiveError("authoritative");

  const nowSec = Math.floor(now.getTime() / 1000);
  const { startActive, endActive, expiry } = calculateTournamentDeadlines(
    leaderboard.startTime,
    leaderboard.endTime,
    leaderboard.duration,
    leaderboard.resetSchedule,
    now,
  );
  if (startActive > nowSec || endActive <= nowSec) throw competitiveError("outside-duration");

  const operator = resolveOperator(leaderboard, input.overrideOperator);
  const existing = await findRecord(db, tenantId, leaderboard.id, expiry, input.ownerId);

  if (leaderboard.joinRequired) {
    if (existing === null) throw competitiveError("join-required");
    const guarded = await db
      .prepare(
        `UPDATE leaderboard_record
         SET ${scoreSql(leaderboard, operator)},
             num_score = leaderboard_record.num_score + 1,
             metadata = COALESCE(?7, leaderboard_record.metadata),
             username = COALESCE(?4, leaderboard_record.username),
             update_time = ?8
         WHERE tenant_id = ?1 AND leaderboard_id = ?2 AND owner_id = ?3 AND expiry_time = ?9
           AND (max_num_score = 0 OR num_score < max_num_score)`,
      )
      .bind(
        tenantId,
        leaderboard.id,
        input.ownerId,
        input.username === "" ? null : input.username,
        input.score,
        input.subscore,
        input.metadata === "" ? null : input.metadata,
        nowSec,
        expiry,
      )
      .run();
    if (guarded.meta.changes === 0) throw competitiveError("max-attempts");
  } else {
    const attempt = (existing?.num_score ?? 0) + 1;
    if (leaderboard.maxNumScore > 0 && attempt > leaderboard.maxNumScore) {
      throw competitiveError("max-attempts");
    }
    const inserted = await db
      .prepare(
        `INSERT INTO leaderboard_record
           (tenant_id, leaderboard_id, owner_id, username, score, subscore, metadata,
            expiry_time, num_score, max_num_score, create_time, update_time)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, '{}'), ?9, ?10, ?11, ?12, ?12)
         ON CONFLICT (tenant_id, owner_id, leaderboard_id, expiry_time)
         DO UPDATE SET
           ${scoreSql(leaderboard, operator)},
           num_score = leaderboard_record.num_score + 1,
           metadata = COALESCE(?7, leaderboard_record.metadata),
           username = COALESCE(?4, leaderboard_record.username),
           update_time = ?12`,
      )
      .bind(
        tenantId,
        leaderboard.id,
        input.ownerId,
        input.username === "" ? null : input.username,
        input.score,
        input.subscore,
        input.metadata === "" ? null : input.metadata,
        nowSec,
        expiry,
        attempt,
        leaderboard.maxNumScore,
        nowSec,
      )
      .run();
    if (inserted.meta.changes !== 1) throw competitiveError("max-attempts");
    if (existing === null && leaderboard.hasMaxSize) {
      const bumped = await adjustLeaderboardSize(db, tenantId, leaderboard.id, 1, true);
      if (bumped.meta.changes !== 1) {
        await deleteRecord(db, tenantId, leaderboard.id, expiry, input.ownerId);
        throw competitiveError("max-size");
      }
    }
  }

  const row = await findRecord(db, tenantId, leaderboard.id, expiry, input.ownerId);
  if (row === null) throw competitiveError("not-found");
  const record = ranked(row);
  record.rank = insertRank(
    leaderboard,
    expiry,
    input.ownerId,
    row.score,
    row.subscore,
    row.num_score,
  );
  return record;
}

export async function tournamentRecordDelete(
  db: D1Database,
  tenantId: string,
  leaderboard: Leaderboard | null,
  callerId: string,
  ownerId: string,
  now: Date,
): Promise<void> {
  if (leaderboard === null || !leaderboard.isTournament) throw competitiveError("not-tournament");
  if (leaderboard.authoritative && callerId !== "") throw competitiveError("authoritative");
  const { expiry } = calculateTournamentDeadlines(
    leaderboard.startTime,
    leaderboard.endTime,
    leaderboard.duration,
    leaderboard.resetSchedule,
    now,
  );
  const removed = await deleteRecord(db, tenantId, leaderboard.id, expiry, ownerId);
  if (removed.meta.changes > 0 && leaderboard.hasMaxSize) {
    await adjustLeaderboardSize(db, tenantId, leaderboard.id, -1, false);
  }
  forgetRank(leaderboard.id, expiry, ownerId);
}

export type { LeaderboardRecordRow };
