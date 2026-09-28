import { describe, expect, it } from "vitest";

import { parseCron } from "../../../src/domain/competitive/cron/expression";
import { computeNext } from "../../../src/domain/competitive/leaderboard/scheduler";
import { toLeaderboard, type LeaderboardRow } from "../../../src/domain/competitive/leaderboard/definition";

/**
 * 调度器重算的**边界秒**。
 *
 * 两条用例都构造"在边界那一秒重算"的场景：上游的调度循环在同一秒里既跑完了
 * `endActive` 回调又重新 `computeNext`，于是任何"上一期的 deadline 还留在竞争里"
 * 的实现都会在这里露馅。
 *
 * 溯源: server/leaderboard_scheduler_test.go::TestLeaderboardSchedulerEndedTournamentHidesLiveExpiry
 * 溯源: server/leaderboard_scheduler_test.go::TestLeaderboardSchedulerEndedTournamentHidesSuccessorExpiry
 */

function board(overrides: Partial<LeaderboardRow> & { readonly id: string }): ReturnType<typeof toLeaderboard> {
  const row: LeaderboardRow = {
    tenant_id: "T",
    authoritative: 0,
    sort_order: 1,
    operator: 0,
    reset_schedule: "",
    metadata: "{}",
    create_time: 0,
    title: "",
    description: "",
    category: 0,
    start_time: 0,
    end_time: 0,
    duration: 0,
    max_size: 0,
    max_num_score: 0,
    join_required: 0,
    enable_ranks: 1,
    size: 0,
    ...overrides,
    id: overrides.id,
  };
  return toLeaderboard(row);
}

function at(seconds: number): Date {
  return new Date(seconds * 1000);
}

describe("computeNext", () => {
  it("已结束的锦标赛不能盖住仍在运行的排行榜", () => {
    const tournamentEnd = 1_700_000_000;
    const hourly = parseCron("0 * * * *");
    const liveExpiry = Math.floor(hourly.next(at(tournamentEnd)).getTime() / 1000);

    const leaderboards = [
      board({ id: "ending-tournament", duration: 3600, start_time: tournamentEnd - 7200, end_time: tournamentEnd }),
      board({ id: "hourly-leaderboard", reset_schedule: "0 * * * *" }),
    ];

    // 边界前一秒：这场锦标赛的 expiry 就是下一个 deadline，理应由它胜出。
    const before = computeNext(leaderboards, at(tournamentEnd - 1));
    expect(before.expiryAt).toBe(tournamentEnd);
    expect(before.expiryIds).toEqual(["ending-tournament"]);

    // 边界那一秒：已结束的锦标赛必须掉出竞争，否则它会把小时级排行榜的重置盖掉。
    const after = computeNext(leaderboards, at(tournamentEnd));
    expect(after.expiryAt).toBe(liveExpiry);
    expect(after.expiryIds).toEqual(["hourly-leaderboard"]);
  });

  it("上一期的 expiry 不能压过下一期的停赛时刻", () => {
    const day1End = 1_700_042_400;
    const day2End = day1End + 86400;

    const leaderboards = [
      board({ id: "day-1", duration: 86400, start_time: day1End - 86400, end_time: day1End }),
      board({ id: "day-2", duration: 86400, start_time: day1End, end_time: day2End }),
    ];

    const plan = computeNext(leaderboards, at(day1End));

    expect(plan.endActiveAt).toBe(day2End);
    expect(plan.endActiveIds).toEqual(["day-2"]);
    expect(plan.expiryAt).toBe(day2End);
    expect(plan.expiryIds).toEqual(["day-2"]);
  });
});
