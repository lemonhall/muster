import { describe, expect, it } from "vitest";

import { RankCache } from "../../../src/domain/competitive/leaderboard/rank-cache";
import { SortOrder } from "../../../src/domain/competitive/leaderboard/definition";

/**
 * 名次缓存的**隔离**：按过期时间、按排行榜 id 各自独立。
 *
 * 这三条用例钉的是"查询键是 `(leaderboardId, expiryTime)` 二元组"。
 * 少一维就会出现"上个月的分数污染这个月的名次"这种最难查的错。
 *
 * 溯源: server/leaderboard_rank_cache_test.go::TestLocalLeaderboardRankCache_TrimExpired
 * 溯源: server/leaderboard_rank_cache_test.go::TestLocalLeaderboardRankCache_ExpirySeparation
 * 溯源: server/leaderboard_rank_cache_test.go::TestLocalLeaderboardRankCache_LeaderboardSeparation
 */

const id = (): string => crypto.randomUUID().toUpperCase();

/** 用固定的一组分数铺一期榜单，返回按名次排好的 ownerId。 */
function seed(cache: RankCache, leaderboardId: string, expiry: number): readonly string[] {
  const owners = [id(), id(), id(), id(), id()];
  const order = SortOrder.Descending;
  cache.insert(leaderboardId, order, 33, 34, 0, expiry, owners[2] as string, true);
  cache.insert(leaderboardId, order, 22, 23, 0, expiry, owners[1] as string, true);
  cache.insert(leaderboardId, order, 44, 45, 0, expiry, owners[3] as string, true);
  cache.insert(leaderboardId, order, 11, 12, 0, expiry, owners[0] as string, true);
  cache.insert(leaderboardId, order, 55, 56, 0, expiry, owners[4] as string, true);
  return [owners[4], owners[3], owners[2], owners[1], owners[0]] as readonly string[];
}

function expectRanked(
  cache: RankCache,
  leaderboardId: string,
  expiry: number,
  ordered: readonly string[],
): void {
  ordered.forEach((owner, index) => {
    expect(cache.get(leaderboardId, expiry, owner)).toBe(index + 1);
  });
}

describe("RankCache 生命周期与隔离", () => {
  it("TrimExpired 清掉已过期的那一期", () => {
    const cache = new RankCache();
    const ordered = seed(cache, "lid", 1);
    expectRanked(cache, "lid", 1, ordered);

    cache.trimExpired(1);

    for (const owner of ordered) expect(cache.get("lid", 1, owner)).toBe(0);
  });

  it("不同过期时间互不干扰", () => {
    const cache = new RankCache();
    const ordered = seed(cache, "lid", 1);
    expectRanked(cache, "lid", 1, ordered);

    for (const owner of ordered) expect(cache.get("lid", 2, owner)).toBe(0);
  });

  it("不同排行榜互不干扰", () => {
    const cache = new RankCache();
    const ordered = seed(cache, "lid", 1);
    expectRanked(cache, "lid", 1, ordered);

    for (const owner of ordered) expect(cache.get("foo", 1, owner)).toBe(0);
  });
});
