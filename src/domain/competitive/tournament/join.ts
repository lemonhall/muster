/**
 * 加入锦标赛：`TournamentJoin` 的等价实现。
 *
 * 三条容易漏掉的语义：
 *   1. `join_required = false` 的锦标赛**直接成功**（不需要任何写入）——上游在这里
 *      连库都不碰；
 *   2. 已经加入过的人再调一次是**成功的空操作**（`ON CONFLICT DO NOTHING` 影响 0 行）；
 *   3. 名额上限的判定在"报名记录已经写进去之后"，满员时要把那条记录删掉——
 *      上游在事务里靠回滚做到，D1 没有交互式事务，这里用一次补偿删除。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_tournament.go::TournamentJoin
 */

import { competitiveError } from "../errors";
import type { Leaderboard } from "../leaderboard/definition";
import { calculateTournamentDeadlines } from "./deadlines";
import { adjustLeaderboardSize, deleteRecord } from "../leaderboard/record-store";

export async function tournamentJoin(
  db: D1Database,
  tenantId: string,
  leaderboard: Leaderboard,
  ownerId: string,
  username: string,
  now: Date,
): Promise<void> {
  if (!leaderboard.isTournament) throw competitiveError("not-found");
  if (!leaderboard.joinRequired) return;

  const { endActive, expiry } = calculateTournamentDeadlines(
    leaderboard.startTime,
    leaderboard.endTime,
    leaderboard.duration,
    leaderboard.resetSchedule,
    now,
  );
  const nowSec = Math.floor(now.getTime() / 1000);
  if (endActive <= nowSec) throw competitiveError("outside-duration");

  const inserted = await db
    .prepare(
      `INSERT INTO leaderboard_record
         (tenant_id, leaderboard_id, owner_id, username, score, subscore, metadata,
          expiry_time, num_score, max_num_score, create_time, update_time)
       VALUES (?1, ?2, ?3, ?4, 0, 0, '{}', ?5, 0, ?6, ?7, ?7)
       ON CONFLICT (tenant_id, owner_id, leaderboard_id, expiry_time) DO NOTHING`,
    )
    .bind(
      tenantId,
      leaderboard.id,
      ownerId,
      username === "" ? null : username,
      expiry,
      leaderboard.maxNumScore,
      nowSec,
    )
    .run();
  if (inserted.meta.changes !== 1) return;

  if (!leaderboard.hasMaxSize) return;
  const bumped = await adjustLeaderboardSize(db, tenantId, leaderboard.id, 1, true);
  if (bumped.meta.changes === 1) return;
  // 满员：把刚写进去的报名记录撤掉，否则"没报上名"的人会永远占着一个位置。
  await deleteRecord(db, tenantId, leaderboard.id, expiry, ownerId);
  throw competitiveError("max-size");
}
