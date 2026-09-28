import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { socialWorld, type SocialAccount, type SocialWorld } from "../../helpers/social-world";
import {
  listRecords,
  makeLeaderboard,
  populate,
  type RecordListBody,
} from "../../helpers/competitive-world";
import { loadLeaderboard } from "../../../src/domain/competitive/leaderboard/context";
import { disableLeaderboardRanks } from "../../../src/domain/competitive/leaderboard/write";

/**
 * "某人前后若干名"（haystack）与"关掉名次"两条：
 * 上游 `TestApiLeaderboard` 的后两个子用例。
 *
 * 为什么这两个子用例必须钉住：haystack 的上方取数与下方补足是两段独立的查询，
 * 窗口从**尾部**切，任何一处把 `limit` 用错都会让 owner 从窗口里滑出去；而
 * "关掉名次"之后记录仍然按分数排序、`rank` 全部归零——名次与排序是两件事。
 *
 * 溯源: server/api_leaderboard_test.go::TestApiLeaderboard
 */

/** 五个人写在降序 + SET 的榜上，返回 world 与榜 id。 */
async function populatedBoard(count = 5): Promise<{
  world: SocialWorld;
  id: string;
  owner: (index: number) => SocialAccount;
}> {
  const world = await socialWorld(count);
  const id = await makeLeaderboard(world, { sort_order: 1, operator: 1, enable_ranks: 1 });
  await populate("leaderboard", world, id);
  return { world, id, owner: (index) => world.accounts[index] as SocialAccount };
}

/** `GET /v2/leaderboard/{id}/owner/{ownerId}?limit=N[&cursor=...]`。 */
function haystack(
  account: SocialAccount,
  id: string,
  ownerId: string,
  limit: number,
  cursor?: string,
): Promise<RecordListBody> {
  const cursorPart = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
  return listRecords("leaderboard", account, `${id}/owner/${ownerId}`, `?limit=${limit}${cursorPart}`);
}

describe("排行榜 haystack（owner 前后若干名）", () => {
  it("中间、榜首、榜尾三个位置各取一页，名次与顺序都对", async () => {
    const { id, owner } = await populatedBoard();
    const viewer = owner(0);

    // 中间：owner 是 30 分（第 3 名），limit=3 → 40/30/20（名次 2/3/4）。
    const middle = await haystack(viewer, id, owner(2).id, 3);
    expect((middle.records ?? []).map((record) => record.score)).toEqual(["40", "30", "20"]);
    expect((middle.records ?? []).map((record) => record.rank)).toEqual(["2", "3", "4"]);
    expect((middle.records ?? []).map((record) => record.owner_id)).toEqual([
      owner(3).id,
      owner(2).id,
      owner(1).id,
    ]);

    // 榜首：owner 是 50 分，上方没人，窗口自然向下滑。
    const top = await haystack(viewer, id, owner(4).id, 3);
    expect((top.records ?? []).map((record) => record.score)).toEqual(["50", "40", "30"]);
    expect((top.records ?? []).map((record) => record.rank)).toEqual(["1", "2", "3"]);

    // 榜尾：owner 是 10 分，下方没人，窗口向上滑。
    const bottom = await haystack(viewer, id, owner(0).id, 3);
    expect((bottom.records ?? []).map((record) => record.score)).toEqual(["30", "20", "10"]);
    expect((bottom.records ?? []).map((record) => record.rank)).toEqual(["3", "4", "5"]);
  });

  it("rank_count 是这一期入榜人数", async () => {
    const { id, owner } = await populatedBoard();

    const body = await haystack(owner(0), id, owner(2).id, 3);

    expect(body.rank_count).toBe("5");
  });

  it("关掉名次之后：顺序照旧，rank 全部归零", async () => {
    const { world, id, owner } = await populatedBoard();
    const leaderboard = await loadLeaderboard(env.DB, world.tenant, id);
    expect(leaderboard).not.toBeNull();
    await disableLeaderboardRanks(
      env.DB,
      world.tenant,
      leaderboard as NonNullable<typeof leaderboard>,
      new Date(),
    );

    const body = await haystack(owner(0), id, owner(2).id, 3);

    expect((body.records ?? []).map((record) => record.score)).toEqual(["40", "30", "20"]);
    expect((body.records ?? []).map((record) => record.rank)).toEqual([undefined, undefined, undefined]);
    expect(body.rank_count).toBeUndefined();
  });
});
