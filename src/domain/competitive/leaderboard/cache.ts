/**
 * 排名缓存的进程内单例，以及"从库里把它补起来"的懒加载。
 *
 * 上游的排名缓存由后台调度器周期性地从库里重建（`localLeaderboardRankCache`
 * 的 fill 循环）；本项目没有常驻后台循环（Cloudflare 上没有"进程"，只有请求
 * 与 Cron 触发），所以改成**第一次读到时懒加载**：某个 (排行榜, 期数) 的缓存
 * 不在内存里，就按库里的顺序灌一遍。可观测行为与"调度器刚好已经跑过一轮"一致。
 * 差异登记在 ECN-0010 偏差 5。
 *
 * 契约源（机器可读）：
 * 契约源: server/leaderboard_rank_cache.go::LocalLeaderboardRankCache.Fill
 */

import { RankCache, type RankFillRecord } from "./rank-cache";
import type { Leaderboard } from "./definition";
import { selectRecords } from "./record-store";

const rankCache = new RankCache();
/** 已经灌过库的 (排行榜, 期数)：避免每次请求都做一次全表读。 */
const loaded = new Set<string>();

function boardKey(leaderboardId: string, expiryTime: number): string {
  return `${leaderboardId}\u0000${expiryTime}`;
}

/** 只给测试用：把缓存清干净，让用例之间互不影响。 */
export function resetRankCache(): void {
  rankCache.clear();
  loaded.clear();
}

export function insertRank(
  leaderboard: Leaderboard,
  expiryTime: number,
  ownerId: string,
  score: number,
  subscore: number,
  generation: number,
): number {
  return rankCache.insert(
    leaderboard.id,
    leaderboard.sortOrder,
    score,
    subscore,
    generation,
    expiryTime,
    ownerId,
    leaderboard.enableRanks,
  );
}

export function getRank(leaderboard: Leaderboard, expiryTime: number, ownerId: string): number {
  return rankCache.get(leaderboard.id, expiryTime, ownerId);
}

export function forgetRank(leaderboardId: string, expiryTime: number, ownerId: string): void {
  rankCache.delete(leaderboardId, expiryTime, ownerId);
}

export function forgetBoard(leaderboardId: string, expiryTime: number): void {
  rankCache.deleteLeaderboard(leaderboardId, expiryTime);
  loaded.delete(boardKey(leaderboardId, expiryTime));
}

/**
 * 灌库：把这一期在库里已有的记录按名次顺序放进缓存，用 `num_score` 当世代号。
 *
 * 世代入缓存的意义是"同一人重新提交时，世代号更大才允许覆盖"——灌库时用的是
 * 库里那份权威世代号，所以此后任何一次新写入都能正确覆盖它在缓存里的旧位置。
 */
async function loadBoard(
  db: D1Database,
  tenantId: string,
  leaderboard: Leaderboard,
  expiryTime: number,
): Promise<void> {
  const key = boardKey(leaderboard.id, expiryTime);
  if (loaded.has(key)) return;
  // 先登记再读：并发请求同时进来时只会有一次真正的读，后来的那次拿到的是
  // "已登记"，它读到的可能是半个缓存——所以登记必须发生在读之后。
  const rows = await selectRecords(db, tenantId, leaderboard.id, expiryTime, {
    direction: leaderboard.sortOrder === 1 ? "desc" : "asc",
    limit: 0,
  });
  loaded.add(key);
  for (const row of rows.results) {
    rankCache.insert(
      leaderboard.id,
      leaderboard.sortOrder,
      row.score,
      row.subscore,
      row.num_score,
      expiryTime,
      row.owner_id,
      leaderboard.enableRanks,
    );
  }
}

/** 给一批记录填名次，并返回这一期缓存里的条目总数（`RankCount`）。 */
export async function fillRanks(
  db: D1Database,
  tenantId: string,
  leaderboard: Leaderboard,
  expiryTime: number,
  records: readonly RankFillRecord[],
): Promise<number> {
  if (!leaderboard.enableRanks) return 0;
  await loadBoard(db, tenantId, leaderboard, expiryTime);
  return rankCache.fill(leaderboard.id, expiryTime, records, true);
}
