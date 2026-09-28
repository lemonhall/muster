/**
 * "某人在榜上前后若干名"：`getLeaderboardRecordsHaystack` 的等价实现。
 *
 * 算法本身不长，但它的取值窗口不是"以 owner 为中心的 limit 条"——上游是分两段取：
 *   1. 先往**上**取 `limit+1` 条（多那条只用于判断"上面还有没有"）；
 *   2. 再往**下**取 `secondLimit+1` 条，其中 `secondLimit = limit/2`，
 *      上方不足时才补足到 `limit - 上方条数`；
 *   3. 把"上方（反转后）+ owner + 下方"拼起来，再从**尾部**切 `limit` 条。
 *
 * 第 3 步的"从尾部切"是这套算法的关键：它保证 owner 一定落在窗口里（上方不足时
 * 窗口自然向下滑），而 `prev_cursor` / `next_cursor` 分别指向切完之后的
 * 第一条与最后一条。`prev_cursor != next_cursor` 是必须成立的——上游曾把两者写成
 * 同一个值，`api_tournament_test.go::TestApiTournamentHaystack` 就是钉这条的。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_leaderboard.go::getLeaderboardRecordsHaystack
 * 契约源: server/core_leaderboard.go::LeaderboardRecordsHaystack
 */

import { SortOrder, type Leaderboard } from "./definition";
import { encodeRecordCursor } from "./cursor";
import { expiryOf } from "./context";
import { fillRanks } from "./cache";
import { findRecord, ranked, selectRecords, type RankedRecord } from "./record-store";
import { leaderboardRecordsList, type LeaderboardRecordListResult } from "./list";

export interface HaystackOptions {
  readonly cursor: string;
  readonly ownerId: string;
  readonly limit: number;
  readonly overrideExpiry: number;
}

const EMPTY: LeaderboardRecordListResult = {
  records: [],
  ownerRecords: [],
  nextCursor: "",
  prevCursor: "",
  rankCount: 0,
};

export async function leaderboardRecordsHaystack(
  db: D1Database,
  tenantId: string,
  leaderboard: Leaderboard,
  options: HaystackOptions,
  now: Date,
): Promise<LeaderboardRecordListResult> {
  const { expiryTime, recordsPossible } = expiryOf(leaderboard, options.overrideExpiry, now);
  if (!recordsPossible) return EMPTY;

  if (options.cursor !== "") {
    // 带游标的 haystack 就是一次普通的记录列表：方向语义完全一样。
    return leaderboardRecordsList(
      db,
      tenantId,
      leaderboard,
      { limit: options.limit, cursor: options.cursor, ownerIds: [], overrideExpiry: expiryTime },
      now,
    );
  }

  const ownerRow = await findRecord(db, tenantId, leaderboard.id, expiryTime, options.ownerId);
  if (ownerRow === null) return EMPTY;
  const owner = ranked(ownerRow);
  const tuple = { score: owner.score, subscore: owner.subscore, ownerId: owner.owner_id };
  const ascending = leaderboard.sortOrder === SortOrder.Ascending;

  // 第一段：往"更好的名次"方向取，取到的是逆序，读回来直接反正。
  const aboveQuery = await selectRecords(db, tenantId, leaderboard.id, expiryTime, {
    tuple,
    // 升序榜上"更好"是更小，所以往上是 `< score`；降序榜上往上是 `> score`。
    operator: ascending ? "<" : ">",
    direction: ascending ? "desc" : "asc",
    limit: options.limit + 1,
  });
  let above = aboveQuery.results.map((row) => ranked(row));
  let setPrevCursor = false;
  if (above.length > options.limit) {
    setPrevCursor = true;
    above = above.slice(0, above.length - 1);
  }
  above.reverse();

  // 第二段：往"更差的名次"方向取，条数按上方实际取到的条数动态调整。
  let secondLimit = Math.floor(options.limit / 2);
  if (above.length < secondLimit) secondLimit = options.limit - above.length;
  const belowQuery = await selectRecords(db, tenantId, leaderboard.id, expiryTime, {
    tuple,
    operator: ascending ? ">" : "<",
    direction: ascending ? "asc" : "desc",
    limit: secondLimit + 1,
  });
  let below = belowQuery.results.map((row) => ranked(row));
  const setNextCursor = below.length > secondLimit;
  if (setNextCursor) below = below.slice(0, below.length - 1);

  const combined: RankedRecord[] = [...above, owner, ...below];
  let start = combined.length - options.limit;
  if (start < 0 || above.length < secondLimit) start = 0;
  if (start > 0) setPrevCursor = true;
  const page = combined.slice(start, Math.min(start + options.limit, combined.length));

  const rankCount = await fillRanks(db, tenantId, leaderboard, expiryTime, page);

  const first = page[0];
  const last = page[page.length - 1];
  return {
    records: page,
    ownerRecords: [],
    prevCursor:
      setPrevCursor && first !== undefined
        ? encodeRecordCursor({
            isNext: false,
            leaderboardId: leaderboard.id,
            expiryTime,
            score: first.score,
            subscore: first.subscore,
            ownerId: first.owner_id,
            rank: first.rank,
          })
        : "",
    nextCursor:
      setNextCursor && last !== undefined
        ? encodeRecordCursor({
            isNext: true,
            leaderboardId: leaderboard.id,
            expiryTime,
            score: last.score,
            subscore: last.subscore,
            ownerId: last.owner_id,
            rank: last.rank,
          })
        : "",
    rankCount,
  };
}
