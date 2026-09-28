import { describe, expect, it } from "vitest";

import { socialWorld, type SocialAccount } from "../../helpers/social-world";
import {
  listRecords,
  makeTournament,
  populate,
  type RecordListBody,
} from "../../helpers/competitive-world";

/**
 * 锦标赛 haystack：上游 `server/api_tournament_test.go::TestApiTournamentHaystack`。
 *
 * 上游这条用例的**唯一目的**是钉住一个曾经的 bug：`prev_cursor` 与 `next_cursor`
 * 被写成同一个值，于是"往上一页"翻出来的是下一页。所以这里的断言分两层：
 * 中间页是 40/30/20（名次 2/3/4），两个游标各自翻出 50（名次 1）与 10（名次 5）。
 * 只断言"中间页对"是抓不住那个 bug 的。
 *
 * 锦标赛贴的是"best + desc + 7200 秒档 + 已开赛"：上游用 `tournament_create`
 * 造的也是这一组参数，只有 `best` 才让 `WriteTournamentRecord` 的分数覆盖语义
 * 与普通的 Set 榜区分开。
 *
 * 溯源: server/api_tournament_test.go::TestApiTournamentHaystack
 */

function haystack(
  account: SocialAccount,
  id: string,
  ownerId: string,
  cursor?: string,
): Promise<RecordListBody> {
  const cursorPart = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
  return listRecords("tournament", account, `${id}/owner/${ownerId}`, `?limit=3${cursorPart}`);
}

describe("锦标赛 haystack", () => {
  it("中间页是 owner 前后各一名，两个游标分别指向上一页与下一页", async () => {
    const world = await socialWorld(5);
    const id = await makeTournament(world, Math.floor(Date.now() / 1000));
    await populate("tournament", world, id);
    const owner = world.accounts[2] as SocialAccount;
    const viewer = world.accounts[0] as SocialAccount;

    const middle = await haystack(viewer, id, owner.id);

    expect((middle.records ?? []).map((record) => record.score)).toEqual(["40", "30", "20"]);
    expect((middle.records ?? []).map((record) => record.rank)).toEqual(["2", "3", "4"]);
    expect((middle.records ?? []).map((record) => record.owner_id)).toEqual([
      (world.accounts[3] as SocialAccount).id,
      owner.id,
      (world.accounts[1] as SocialAccount).id,
    ]);

    const prev = middle.prev_cursor;
    const next = middle.next_cursor;
    expect(prev).toBeTruthy();
    expect(next).toBeTruthy();
    expect(prev).not.toBe(next);

    // 上一页：排在中间页之上的那一条（50 分、第 1 名）。
    const prevPage = await haystack(viewer, id, owner.id, prev);
    expect((prevPage.records ?? []).map((record) => record.score)).toEqual(["50"]);
    expect((prevPage.records ?? []).map((record) => record.rank)).toEqual(["1"]);

    // 下一页：排在中间页之下的那一条（10 分、第 5 名）。
    const nextPage = await haystack(viewer, id, owner.id, next);
    expect((nextPage.records ?? []).map((record) => record.score)).toEqual(["10"]);
    expect((nextPage.records ?? []).map((record) => record.rank)).toEqual(["5"]);
  });

  it("记录列表默认 limit 是 10，返回整期榜单", async () => {
    const world = await socialWorld(5);
    const id = await makeTournament(world, Math.floor(Date.now() / 1000));
    await populate("tournament", world, id);

    const body = await listRecords("tournament", world.accounts[0] as SocialAccount, id);

    expect((body.records ?? []).map((record) => record.score)).toEqual([
      "50",
      "40",
      "30",
      "20",
      "10",
    ]);
    expect(body.rank_count).toBe("5");
  });
});
