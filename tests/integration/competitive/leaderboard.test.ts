import { describe, expect, it } from "vitest";

import { socialWorld, type SocialAccount } from "../../helpers/social-world";
import {
  deleteScore,
  expectOrderedRecords,
  listRecords,
  makeLeaderboard,
  populate,
  writeScore,
} from "../../helpers/competitive-world";

/**
 * 排行榜的读写面：上游 `server/api_leaderboard_test.go::TestApiLeaderboard` 的
 * 前三个子用例——"建了榜但没有记录"、"覆盖成绩之后顺序变了"、"删掉成绩之后人不见了"。
 *
 * 三个子用例刻意都用 `SortOrderDescending + OperatorSet`（除了第一个用零值定义）：
 * 降序 + Set 是唯一能让"顺序真的会变"的组合，用 BEST 会把覆盖写成"更好才更新"，
 * 于是断言顺序时看不出 SET 语义到底有没有生效。
 *
 * 列表里的 `rank` 是**按位置算出来的**（`i+1`），与 `enable_ranks` 无关——上游
 * `LeaderboardRecordsList` 就是这么填的，名次缓存只管 haystack 与 `rank_count`。
 *
 * 溯源: server/api_leaderboard_test.go::TestApiLeaderboard
 */

describe("排行榜记录读写", () => {
  it("刚建好的榜：列表是空的", async () => {
    const world = await socialWorld(1);
    const id = await makeLeaderboard(world);

    const body = await listRecords("leaderboard", world.accounts[0] as SocialAccount, id);

    expect(body.records ?? []).toEqual([]);
  });

  it("覆盖成绩：SET 运算符让顺序重排", async () => {
    const world = await socialWorld(5);
    const id = await makeLeaderboard(world, { sort_order: 1, operator: 1 });
    await populate("leaderboard", world, id);

    const accounts = world.accounts;
    const descending = [accounts[4], accounts[3], accounts[2], accounts[1], accounts[0]] as SocialAccount[];
    expectOrderedRecords(
      await listRecords("leaderboard", accounts[0] as SocialAccount, id, "?limit=5"),
      descending,
      [50, 40, 30, 20, 10],
      [51, 41, 31, 21, 11],
    );

    // u2 提到 500、u3 提到 200：新的顺序是 500/200/50/20/10。
    await writeScore("leaderboard", accounts[2] as SocialAccount, id, 500, 501);
    await writeScore("leaderboard", accounts[3] as SocialAccount, id, 200, 201);

    expectOrderedRecords(
      await listRecords("leaderboard", accounts[0] as SocialAccount, id, "?limit=5"),
      [accounts[2], accounts[3], accounts[4], accounts[1], accounts[0]] as SocialAccount[],
      [500, 200, 50, 20, 10],
      [501, 201, 51, 21, 11],
    );
  });

  it("删掉成绩：被删的人从列表里消失，其余人补齐名次", async () => {
    const world = await socialWorld(5);
    const id = await makeLeaderboard(world, { sort_order: 1, operator: 1 });
    await populate("leaderboard", world, id);

    const accounts = world.accounts;
    for (const index of [2, 3]) {
      expect(await deleteScore("leaderboard", accounts[index] as SocialAccount, id)).toBe(200);
    }

    expectOrderedRecords(
      await listRecords("leaderboard", accounts[0] as SocialAccount, id, "?limit=5"),
      [accounts[4], accounts[1], accounts[0]] as SocialAccount[],
      [50, 20, 10],
      [51, 21, 11],
    );
  });

  it("写分返回的记录带 score/subscore/owner", async () => {
    const world = await socialWorld(1);
    const id = await makeLeaderboard(world, { sort_order: 1, operator: 1 });

    const record = await writeScore("leaderboard", world.accounts[0] as SocialAccount, id, 7, 8);

    expect(record.score).toBe("7");
    expect(record.subscore).toBe("8");
    expect(record.owner_id).toBe((world.accounts[0] as SocialAccount).id);
  });
});
