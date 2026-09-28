/**
 * 排行榜/锦标赛定义的读取，以及"这一期是哪一期"的判定。
 *
 * 上游把定义放在 `LeaderboardCache`（进程内内存表），本项目把同一份定义放在 D1
 * 的 `leaderboard` 表里——多个 isolate 因此天然看到同一份定义，不需要一致性广播。
 * 差异登记在 ECN-0010 偏差 1。
 *
 * 契约源（机器可读）：
 * 契约源: server/leaderboard_cache.go::LocalLeaderboardCache.Get
 */

import { resolveExpiry } from "../tournament/deadlines";
import { toLeaderboard, type Leaderboard, type LeaderboardRow } from "./definition";
import { findLeaderboard } from "./store";

export interface ExpiryResolution {
  /** 这一期的记录挂在哪个 `expiry_time` 上。`0` 表示"永不作废"。 */
  readonly expiryTime: number;
  /**
   * `false` 表示这一期已经过去（锦标赛的 expiry 落在当前时刻之前）。
   * 上游在这种情况下**不报错**，而是回一个空列表——"这一期没有记录"与
   * "这个排行榜不存在"是两件事。
   */
  readonly recordsPossible: boolean;
}

export async function loadLeaderboard(
  db: D1Database,
  tenantId: string,
  id: string,
): Promise<Leaderboard | null> {
  const row = await findLeaderboard(db, tenantId, id);
  return row === null ? null : toLeaderboard(row);
}

export function expiryOf(
  leaderboard: Leaderboard,
  overrideExpiry: number,
  now: Date,
): ExpiryResolution {
  const resolution = resolveExpiry(overrideExpiry, leaderboard, now);
  return { expiryTime: resolution.expiry, recordsPossible: resolution.recordsPossible };
}

export type { Leaderboard, LeaderboardRow };
