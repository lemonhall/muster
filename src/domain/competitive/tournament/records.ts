/**
 * 锦标赛的记录列表与 haystack。
 *
 * 两者都只是 `leaderboard` 那一层的包装，多出来的只有"这必须是锦标赛"和
 * "结束时该报哪个错"两条判断：
 *   - 记录列表在**已结束**时报 `NotFound`（上游用专门的 `ErrTournamentOutsideDuration`
 *     分支，文案是 `Tournament has ended.`）；
 *   - haystack 在已结束时**回空列表**，不报错——因为它是"取某人附近的名次"，
 *     "这一期没有记录"就是空的正常答案。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_tournament.go::TournamentRecordsList
 * 契约源: server/core_tournament.go::TournamentRecordsHaystack
 */

import { competitiveError } from "../errors";
import type { Leaderboard } from "../leaderboard/definition";
import { calculateTournamentDeadlines } from "./deadlines";
import {
  leaderboardRecordsList,
  type LeaderboardRecordsListOptions,
  type LeaderboardRecordListResult,
} from "../leaderboard/list";
import {
  leaderboardRecordsHaystack,
  type HaystackOptions,
} from "../leaderboard/haystack";

const EMPTY: LeaderboardRecordListResult = {
  records: [],
  ownerRecords: [],
  nextCursor: "",
  prevCursor: "",
  rankCount: 0,
};

function requireTournament(leaderboard: Leaderboard | null): Leaderboard {
  if (leaderboard === null || !leaderboard.isTournament) throw competitiveError("not-tournament");
  return leaderboard;
}

export async function tournamentRecordsList(
  db: D1Database,
  tenantId: string,
  leaderboard: Leaderboard | null,
  options: LeaderboardRecordsListOptions,
  now: Date,
): Promise<LeaderboardRecordListResult> {
  const tournament = requireTournament(leaderboard);
  if (
    options.overrideExpiry === 0 &&
    tournament.endTime > 0 &&
    tournament.endTime <= Math.floor(now.getTime() / 1000)
  ) {
    throw competitiveError("ended");
  }
  return leaderboardRecordsList(db, tenantId, tournament, options, now);
}

export async function tournamentRecordsHaystack(
  db: D1Database,
  tenantId: string,
  leaderboard: Leaderboard | null,
  options: HaystackOptions,
  now: Date,
): Promise<LeaderboardRecordListResult> {
  const tournament = requireTournament(leaderboard);
  let overrideExpiry = options.overrideExpiry;
  if (overrideExpiry === 0) {
    const { expiry } = calculateTournamentDeadlines(
      tournament.startTime,
      tournament.endTime,
      tournament.duration,
      tournament.resetSchedule,
      now,
    );
    if (expiry !== 0 && expiry <= Math.floor(now.getTime() / 1000)) return EMPTY;
    overrideExpiry = expiry;
  }
  return leaderboardRecordsHaystack(
    db,
    tenantId,
    tournament,
    { ...options, overrideExpiry },
    now,
  );
}

/** 写分与删分都要先确认"这是个锦标赛"（普通排行榜走另一套端点）。 */
export function asTournament(leaderboard: Leaderboard | null): Leaderboard {
  return requireTournament(leaderboard);
}
