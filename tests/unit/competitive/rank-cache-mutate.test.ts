import { describe, expect, it } from "vitest";

import { RankCache } from "../../../src/domain/competitive/leaderboard/rank-cache";
import { SortOrder } from "../../../src/domain/competitive/leaderboard/definition";

/**
 * 名次缓存的删除与批量填名次。
 *
 * `Fill` 的返回值容易被误读：它不是"填了几条"，而是**这一期缓存里的总条目数**
 * （上游 `rankCache.cache.Len()`），对外就是 `rank_count`。所以这里连返回值一起断言。
 *
 * 溯源: server/leaderboard_rank_cache_test.go::TestLocalLeaderboardRankCache_Delete, TestLocalLeaderboardRankCache_DeleteLeaderboard, TestLocalLeaderboardRankCache_Fill
 */

const id = (): string => crypto.randomUUID().toUpperCase();

function seed(cache: RankCache): readonly string[] {
  const owners = [id(), id(), id(), id(), id()];
  const order = SortOrder.Descending;
  cache.insert("lid", order, 33, 34, 0, 0, owners[2] as string, true);
  cache.insert("lid", order, 22, 23, 0, 0, owners[1] as string, true);
  cache.insert("lid", order, 44, 45, 0, 0, owners[3] as string, true);
  cache.insert("lid", order, 11, 12, 0, 0, owners[0] as string, true);
  cache.insert("lid", order, 55, 56, 0, 0, owners[4] as string, true);
  return owners;
}

describe("RankCache 删除与填充", () => {
  it("删掉中间一条之后，后面的人名次整体前移", () => {
    const cache = new RankCache();
    const [u1, u2, u3, u4, u5] = seed(cache) as [string, string, string, string, string];
    expect(cache.get("lid", 0, u5)).toBe(1);
    expect(cache.get("lid", 0, u4)).toBe(2);
    expect(cache.get("lid", 0, u3)).toBe(3);
    expect(cache.get("lid", 0, u2)).toBe(4);
    expect(cache.get("lid", 0, u1)).toBe(5);

    cache.delete("lid", 0, u4);

    expect(cache.get("lid", 0, u5)).toBe(1);
    expect(cache.get("lid", 0, u4)).toBe(0);
    expect(cache.get("lid", 0, u3)).toBe(2);
    expect(cache.get("lid", 0, u2)).toBe(3);
    expect(cache.get("lid", 0, u1)).toBe(4);
  });

  it("DeleteLeaderboard 清掉整期", () => {
    const cache = new RankCache();
    const owners = seed(cache);
    expect(cache.get("lid", 0, owners[4] as string)).toBe(1);

    cache.deleteLeaderboard("lid", 0);

    for (const owner of owners) expect(cache.get("lid", 0, owner)).toBe(0);
  });

  it("Fill 按名次填 Rank 并返回这一期的总条目数", () => {
    const cache = new RankCache();
    const [u1, u2, u3, u4, u5] = seed(cache) as [string, string, string, string, string];

    const records = [
      { ownerId: u3, score: 33, subscore: 34, rank: 0 },
      { ownerId: u1, score: 11, subscore: 12, rank: 0 },
      { ownerId: u5, score: 55, subscore: 56, rank: 0 },
      { ownerId: u2, score: 22, subscore: 23, rank: 0 },
      { ownerId: u4, score: 44, subscore: 45, rank: 0 },
    ];

    expect(cache.fill("lid", 0, records, true)).toBe(5);
    expect(records.map((record) => record.rank)).toEqual([3, 5, 1, 4, 2]);
  });

  it("关掉名次（enableRanks=false）时插入与填充都返回 0", () => {
    const cache = new RankCache();
    const owners = seed(cache);
    const records = [{ ownerId: owners[4] as string, score: 55, subscore: 56, rank: 7 }];

    expect(cache.fill("lid", 0, records, false)).toBe(0);
    expect(records[0]?.rank).toBe(7);
    expect(cache.insert("lid", SortOrder.Descending, 1, 1, 5, 0, id(), false)).toBe(0);
  });
});
