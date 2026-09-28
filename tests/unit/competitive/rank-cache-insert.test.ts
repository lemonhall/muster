import { describe, expect, it } from "vitest";

import { RankCache } from "../../../src/domain/competitive/leaderboard/rank-cache";
import { SortOrder } from "../../../src/domain/competitive/leaderboard/definition";

/**
 * 名次缓存的插入与世代号覆盖。
 *
 * 上游把"同一个人重新提交分数"表达成 `generation`（就是 `num_score`）：世代号
 * 更大才覆盖，否则保持原样。用例逐条搬运自 `leaderboard_rank_cache_test.go`，
 * 断言的是**名次数值**（外部可观测的那部分），不是跳表内部结构。
 *
 * 溯源: server/leaderboard_rank_cache_test.go::TestLocalLeaderboardRankCache_Insert_Ascending
 * 溯源: server/leaderboard_rank_cache_test.go::TestLocalLeaderboardRankCache_Insert_Descending
 * 溯源: server/leaderboard_rank_cache_test.go::TestLocalLeaderboardRankCache_Insert_Existing
 */

const id = (): string => crypto.randomUUID().toUpperCase();

describe("RankCache 插入", () => {
  it("升序榜：分数越小名次越前", () => {
    const cache = new RankCache();
    const [u1, u2, u3, u4, u5] = [id(), id(), id(), id(), id()];
    const order = SortOrder.Ascending;

    cache.insert("lid", order, 33, 34, 0, 0, u3, true);
    cache.insert("lid", order, 22, 23, 0, 0, u2, true);
    cache.insert("lid", order, 44, 45, 0, 0, u4, true);
    cache.insert("lid", order, 11, 12, 0, 0, u1, true);
    cache.insert("lid", order, 55, 56, 0, 0, u5, true);

    expect(cache.get("lid", 0, u1)).toBe(1);
    expect(cache.get("lid", 0, u2)).toBe(2);
    expect(cache.get("lid", 0, u3)).toBe(3);
    expect(cache.get("lid", 0, u4)).toBe(4);
    expect(cache.get("lid", 0, u5)).toBe(5);
  });

  it("降序榜：分数越大名次越前，同分比 subscore", () => {
    const cache = new RankCache();
    const [u1, u2, u3, u4, u5, u5a] = [id(), id(), id(), id(), id(), id()];
    const order = SortOrder.Descending;

    cache.insert("lid", order, 33, 34, 0, 0, u3, true);
    cache.insert("lid", order, 22, 23, 0, 0, u2, true);
    cache.insert("lid", order, 44, 45, 0, 0, u4, true);
    cache.insert("lid", order, 11, 12, 0, 0, u1, true);
    cache.insert("lid", order, 55, 56, 0, 0, u5, true);
    cache.insert("lid", order, 55, 57, 0, 0, u5a, true);

    expect(cache.get("lid", 0, u5a)).toBe(1);
    expect(cache.get("lid", 0, u5)).toBe(2);
    expect(cache.get("lid", 0, u4)).toBe(3);
    expect(cache.get("lid", 0, u3)).toBe(4);
    expect(cache.get("lid", 0, u2)).toBe(5);
    expect(cache.get("lid", 0, u1)).toBe(6);
  });

  it("同一人重新提交：世代号更大才覆盖旧记录", () => {
    const cache = new RankCache();
    const [u1, u2, u3, u4, u5] = [id(), id(), id(), id(), id()];
    const order = SortOrder.Descending;

    cache.insert("lid", order, 33, 34, 0, 0, u3, true);
    cache.insert("lid", order, 22, 23, 0, 0, u2, true);
    cache.insert("lid", order, 44, 45, 0, 0, u4, true);
    cache.insert("lid", order, 11, 12, 0, 0, u1, true);
    cache.insert("lid", order, 55, 56, 0, 0, u5, true);
    cache.insert("lid", order, 55, 57, 1, 0, u2, true);

    expect(cache.get("lid", 0, u2)).toBe(1);
    expect(cache.get("lid", 0, u5)).toBe(2);
    expect(cache.get("lid", 0, u4)).toBe(3);
    expect(cache.get("lid", 0, u3)).toBe(4);
    expect(cache.get("lid", 0, u1)).toBe(5);

    // 世代号没有变大：记录不动，返回 0（上游在有新节点、但没插进跳表时查名次的结果）。
    expect(cache.insert("lid", order, 99, 99, 1, 0, u2, true)).toBe(0);
    expect(cache.get("lid", 0, u2)).toBe(1);
  });
});
