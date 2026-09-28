/**
 * 排行榜记录列表：`LeaderboardRecordsList` 的等价实现。
 *
 * 三件事必须与上游逐字对齐，否则客户端的分页会"看起来能用但会漏人"：
 *
 * 1. **两个游标的方向语义**。`is_next=false` 的游标表示"往更好的名次翻"，
 *    `is_next=true` 表示"往更差的名次翻"。在升序榜上这两个方向对应的 SQL 比较
 *    与降序榜上恰好相反，所以判断条件写成 `(asc && isNext) || (!asc && !isNext)`
 *    这一步不能简化。
 * 2. **名次是算出来的，不是查出来的**。翻页时以游标里带的 `rank` 为起点，
 *    每读一条 `rank±1`；这就是为什么游标里必须带 rank。
 * 3. **多取一条来判断"还有没有下一页"**，多出来的那条只用于置游标、不进结果。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_leaderboard.go::LeaderboardRecordsList
 */

import { SortOrder, type Leaderboard } from "./definition";
import { decodeRecordCursor, encodeRecordCursor, type RecordListCursor } from "./cursor";
import { expiryOf } from "./context";
import { fillRanks } from "./cache";
import { ranked, selectRecords, type LeaderboardRecordRow, type RankedRecord } from "./record-store";

export interface LeaderboardRecordListResult {
  readonly records: readonly RankedRecord[];
  readonly ownerRecords: readonly RankedRecord[];
  readonly nextCursor: string;
  readonly prevCursor: string;
  readonly rankCount: number;
}

export interface LeaderboardRecordsListOptions {
  /** `null` 表示"不算排行榜，只回 owner 记录"（上游 `limit == nil` 的那条分支）。 */
  readonly limit: number | null;
  readonly cursor: string;
  readonly ownerIds: readonly string[];
  readonly overrideExpiry: number;
}

const EMPTY: LeaderboardRecordListResult = {
  records: [],
  ownerRecords: [],
  nextCursor: "",
  prevCursor: "",
  rankCount: 0,
};

function cursorFor(
  leaderboardId: string,
  expiryTime: number,
  row: LeaderboardRecordRow,
  rank: number,
  isNext: boolean,
): RecordListCursor {
  return {
    isNext,
    leaderboardId,
    expiryTime,
    score: row.score,
    subscore: row.subscore,
    ownerId: row.owner_id,
    rank,
  };
}

interface PageResult {
  readonly records: readonly RankedRecord[];
  readonly nextCursor: string;
  readonly prevCursor: string;
}

async function readPage(
  db: D1Database,
  tenantId: string,
  leaderboard: Leaderboard,
  expiryTime: number,
  limit: number,
  cursor: string,
): Promise<PageResult> {
  const ascending = leaderboard.sortOrder === SortOrder.Ascending;
  const incoming = cursor === "" ? null : decodeRecordCursor(cursor, leaderboard.id, expiryTime);
  // 取数方向与比较方向必须成对：`>` 配 ASC、`<` 配 DESC。
  let direction: "asc" | "desc";
  let operator: ">" | "<";
  if (incoming === null) {
    direction = ascending ? "asc" : "desc";
    operator = "<";
  } else if ((ascending && incoming.isNext) || (!ascending && !incoming.isNext)) {
    direction = "asc";
    operator = ">";
  } else {
    direction = "desc";
    operator = "<";
  }
  const result = await selectRecords(db, tenantId, leaderboard.id, expiryTime, {
    direction,
    operator,
    limit: limit + 1,
    ...(incoming === null
      ? {}
      : { tuple: { score: incoming.score, subscore: incoming.subscore, ownerId: incoming.ownerId } }),
  });

  const page: LeaderboardRecordRow[] = [];
  const ranks: number[] = [];
  let rank = incoming === null ? 0 : incoming.rank;
  let overflow = false;
  let firstCursor: RecordListCursor | null = null;
  for (const row of result.results) {
    if (page.length >= limit) {
      overflow = true;
      break;
    }
    rank += incoming !== null && !incoming.isNext ? -1 : 1;
    page.push(row);
    ranks.push(rank);
    if (incoming !== null && firstCursor === null) {
      firstCursor = cursorFor(leaderboard.id, expiryTime, row, rank, false);
    }
  }

  const last = page[page.length - 1];
  const lastRank = ranks[ranks.length - 1] ?? 0;
  const trailing =
    overflow && last !== undefined
      ? cursorFor(leaderboard.id, expiryTime, last, lastRank, true)
      : null;

  if (incoming === null) {
    return {
      records: page.map((row, index) => ranked(row, ranks[index] as number)),
      nextCursor: trailing === null ? "" : encodeRecordCursor(trailing),
      prevCursor: "",
    };
  }
  if (incoming.isNext) {
    return {
      records: page.map((row, index) => ranked(row, ranks[index] as number)),
      nextCursor: trailing === null ? "" : encodeRecordCursor(trailing),
      prevCursor: firstCursor === null ? "" : encodeRecordCursor(firstCursor),
    };
  }
  // 向上翻页：结果要翻回正常顺序，并把两个游标对调（"再往上"变成 prev）。
  return {
    records: page.map((row, index) => ranked(row, ranks[index] as number)).reverse(),
    nextCursor: firstCursor === null ? "" : encodeRecordCursor({ ...firstCursor, isNext: true }),
    prevCursor: trailing === null ? "" : encodeRecordCursor({ ...trailing, isNext: false }),
  };
}

export async function leaderboardRecordsList(
  db: D1Database,
  tenantId: string,
  leaderboard: Leaderboard,
  options: LeaderboardRecordsListOptions,
  now: Date,
): Promise<LeaderboardRecordListResult> {
  const { expiryTime, recordsPossible } = expiryOf(leaderboard, options.overrideExpiry, now);
  if (!recordsPossible) return EMPTY;

  let page: PageResult = { records: [], nextCursor: "", prevCursor: "" };
  if (options.limit !== null) {
    page = await readPage(db, tenantId, leaderboard, expiryTime, options.limit, options.cursor);
  }

  // owner 记录：与分页无关，永远是"这一期里这些人的记录"，按榜单顺序排好后统一填名次。
  let ownerRecords: readonly RankedRecord[] = [];
  if (options.ownerIds.length > 0) {
    const owners = await selectRecords(db, tenantId, leaderboard.id, expiryTime, {
      direction: leaderboard.sortOrder === SortOrder.Ascending ? "asc" : "desc",
      limit: 0,
      ownerIds: options.ownerIds,
    });
    ownerRecords = owners.results.map((row) => ranked(row));
  }
  const rankCount = await fillRanks(db, tenantId, leaderboard, expiryTime, ownerRecords);

  return {
    records: page.records,
    ownerRecords,
    nextCursor: page.nextCursor,
    prevCursor: page.prevCursor,
    rankCount,
  };
}
