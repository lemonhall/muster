/**
 * 排行榜调度：下一次"停赛"与下一次"作废"分别落在哪一秒、涉及哪些 id。
 *
 * 上游是常驻进程里的一个 `case <-timer.C` 循环（`scheduleLoop`），本项目没有常驻循环
 * ——Cloudflare 上的等价物是 **Cron Trigger**（每轮进来重算一次下一次该做什么）。
 * 所以这里搬的是那个循环里唯一有语义的核心：`computeNext`。
 *
 * `computeNext` 的两条容易写错的规则（上游 `leaderboard_scheduler_test.go` 各有一条用例）：
 *   1. **已经结束的锦标赛必须掉出竞争**：它的 expiry 恰好等于"结束这一刻"，
 *      若不特判，它就会以最小 deadline 的身份赢下归约，把真正该重置的
 *      小时级排行榜盖掉；
 *   2. 同理，上一期的 expiry 不能压过下一期的 end_state——否则在边界那一秒
 *      重算，`lastFire` 会把这一轮过掉，下一期的重置hook 永远不触发。
 *
 * 契约源（机器可读）：
 * 契约源: server/leaderboard_scheduler.go::LocalLeaderboardScheduler.computeNext
 */

import { calculateTournamentDeadlines } from "../tournament/deadlines";
import type { Leaderboard } from "./definition";

export interface SchedulerPlan {
  /** 下一次"停赛"的时刻；没有就是 -1。 */
  readonly endActiveAt: number;
  /** 下一次"作废/重置"的时刻；没有就是 -1。 */
  readonly expiryAt: number;
  readonly endActiveIds: readonly string[];
  readonly expiryIds: readonly string[];
}

/** `-1` 是上游的"没有下一个 deadline"哨兵值（不是 0）。 */
export function computeNext(leaderboards: readonly Leaderboard[], now: Date): SchedulerPlan {
  const nowUnix = Math.floor(now.getTime() / 1000);
  let endActiveAt = -1;
  let expiryAt = -1;
  const endActiveIds: string[] = [];
  const expiryIds: string[] = [];

  for (const leaderboard of leaderboards) {
    if (leaderboard.isTournament) {
      if (leaderboard.endTime > 0 && leaderboard.endTime < nowUnix) {
        // 这场锦标赛已经永久结束，不再参与任何 deadline 竞争。
        continue;
      }

      const { endActive, expiry } = calculateTournamentDeadlines(
        leaderboard.startTime,
        leaderboard.endTime,
        leaderboard.duration,
        leaderboard.resetSchedule,
        now,
      );

      if (endActive > 0 && nowUnix < endActive) {
        if (endActiveAt < 0 || endActive < endActiveAt) {
          endActiveAt = endActive;
          endActiveIds.length = 0;
          endActiveIds.push(leaderboard.id);
        } else if (endActive === endActiveAt) {
          endActiveIds.push(leaderboard.id);
        }
      }

      if (expiry > 0 && nowUnix < expiry) {
        if (expiryAt < 0 || expiry < expiryAt) {
          expiryAt = expiry;
          expiryIds.length = 0;
          expiryIds.push(leaderboard.id);
        } else if (expiry === expiryAt) {
          expiryIds.push(leaderboard.id);
        }
      }
      continue;
    }

    // 纯排行榜不会"结束"，只会在重置点上作废。
    if (leaderboard.resetSchedule !== null) {
      const expiry = Math.floor(leaderboard.resetSchedule.next(now).getTime() / 1000);
      if (expiryAt < 0 || expiry < expiryAt) {
        expiryAt = expiry;
        expiryIds.length = 0;
        expiryIds.push(leaderboard.id);
      } else if (expiry === expiryAt) {
        expiryIds.push(leaderboard.id);
      }
    }
  }

  return { endActiveAt, expiryAt, endActiveIds, expiryIds };
}
