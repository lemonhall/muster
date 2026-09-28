/**
 * 排行榜名次缓存：把上游的**内存跳表 + 世代号**换成**有序数组 + 世代号**。
 *
 * 为什么可以换：上游 `LocalLeaderboardRankCache` 的可观测行为只有三条——
 *   (1) `Insert` 返回插入后该记录的名次；
 *   (2) `Get` 返回名次（不在缓存里就是 0）；
 *   (3) `Fill` 给一批记录按名次填 `Rank`，并返回这一期缓存里的总条目数。
 * 跳表是实现细节：它的 O(log n) 插入换到有序数组上是 O(n) 的一次搬运，
 * 但我们一次 HTTP 请求最多几千条记录，而**正确性**（名次数值、并列时的次序、
 * 世代号覆盖旧记录）与跳表逐条一致。差异登记在 ECN-0010 偏差 5。
 *
 * 排序与上游 `RankAsc.Less` / `RankDesc.Less` 逐条对齐：
 *   ASC ：score 小者在前，再 subscore 小者在前，再 ownerId 字节序小者在前；
 *   DESC：score 大者在前，再 subscore 大者在前，再 ownerId 字节序大者在前。
 * （UUID 的规范大写十六进制文本与它的字节序同序，所以字符串比较即字节比较。）
 *
 * 契约源（机器可读）：
 * 契约源: server/leaderboard_rank_cache.go::LocalLeaderboardRankCache.Insert
 * 契约源: server/leaderboard_rank_cache.go::LocalLeaderboardRankCache.Get
 * 契约源: server/leaderboard_rank_cache.go::LocalLeaderboardRankCache.Fill
 * 契约源: server/leaderboard_rank_cache.go::LocalLeaderboardRankCache.Delete
 * 契约源: server/leaderboard_rank_cache.go::LocalLeaderboardRankCache.DeleteLeaderboard
 * 契约源: server/leaderboard_rank_cache.go::LocalLeaderboardRankCache.TrimExpired
 */

import { SortOrder } from "./definition";

export interface RankEntry {
  readonly ownerId: string;
  readonly score: number;
  readonly subscore: number;
  readonly generation: number;
}

export interface RankFillRecord {
  ownerId: string;
  rank: number;
}

function compareOwner(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** 负数表示 `left` 名次更靠前（更好）。 */
export function compareRanks(
  sortOrder: number,
  left: { readonly score: number; readonly subscore: number; readonly ownerId: string },
  right: { readonly score: number; readonly subscore: number; readonly ownerId: string },
): number {
  const ascending = sortOrder === SortOrder.Ascending;
  if (left.score !== right.score) {
    const byScore = left.score - right.score;
    return ascending ? byScore : -byScore;
  }
  if (left.subscore !== right.subscore) {
    const bySubscore = left.subscore - right.subscore;
    return ascending ? bySubscore : -bySubscore;
  }
  const byOwner = compareOwner(left.ownerId, right.ownerId);
  return ascending ? byOwner : -byOwner;
}

interface Board {
  readonly sortOrder: number;
  /** 名次升序（best first）的条目表。 */
  entries: RankEntry[];
}

function keyOf(leaderboardId: string, expiryUnix: number): string {
  return `${leaderboardId}\u0000${expiryUnix}`;
}

export class RankCache {
  readonly #boards = new Map<string, Board>();
  readonly #blacklistAll: boolean;
  readonly #blacklisted: ReadonlySet<string>;

  constructor(options: { blacklistAll?: boolean; blacklistedIds?: readonly string[] } = {}) {
    this.#blacklistAll = options.blacklistAll ?? false;
    this.#blacklisted = new Set(options.blacklistedIds ?? []);
  }

  #allowed(leaderboardId: string): boolean {
    if (this.#blacklistAll) return false;
    return !this.#blacklisted.has(leaderboardId);
  }

  #board(leaderboardId: string, expiryUnix: number, sortOrder: number): Board {
    const key = keyOf(leaderboardId, expiryUnix);
    const existing = this.#boards.get(key);
    if (existing !== undefined) return existing;
    const created: Board = { sortOrder, entries: [] };
    this.#boards.set(key, created);
    return created;
  }

  #indexOf(board: Board, ownerId: string): number {
    return board.entries.findIndex((entry) => entry.ownerId === ownerId);
  }

  /**
   * 插入或覆盖一条记录，返回它的名次。
   *
   * 覆盖规则与上游一致：只有 `generation` **更大**时才替换（`num_score` 就是世代号，
   * 同一期里写第 n 次就是第 n 代）。世代号没有变大时记录不动，返回 0——
   * 上游在一棵没插入这棵新节点的跳表上查名次，得到的也是 0。
   */
  insert(
    leaderboardId: string,
    sortOrder: number,
    score: number,
    subscore: number,
    generation: number,
    expiryUnix: number,
    ownerId: string,
    enableRanks: boolean,
  ): number {
    if (!enableRanks || !this.#allowed(leaderboardId)) return 0;
    const board = this.#board(leaderboardId, expiryUnix, sortOrder);
    const index = this.#indexOf(board, ownerId);
    if (index !== -1) {
      const previous = board.entries[index] as RankEntry;
      if (generation <= previous.generation) return 0;
      board.entries.splice(index, 1);
    }
    const entry: RankEntry = { ownerId, score, subscore, generation };
    const at = board.entries.findIndex((candidate) => compareRanks(sortOrder, entry, candidate) < 0);
    if (at === -1) board.entries.push(entry);
    else board.entries.splice(at, 0, entry);
    return at === -1 ? board.entries.length : at + 1;
  }

  /** 名次（1 起）；没有这条记录、缓存被禁用、或这一期不在缓存里都是 0。 */
  get(leaderboardId: string, expiryUnix: number, ownerId: string): number {
    if (!this.#allowed(leaderboardId)) return 0;
    const board = this.#boards.get(keyOf(leaderboardId, expiryUnix));
    if (board === undefined) return 0;
    const index = this.#indexOf(board, ownerId);
    return index === -1 ? 0 : index + 1;
  }

  /**
   * 给一批记录填名次，返回这一期缓存里的总条目数。
   *
   * 上游的返回语义很关键：它**不是**"填了几条"，而是 `rankCache.cache.Len()`——
   * 也就是这一期排行榜上一共有多少个入榜者。`RankCount` 就靠它。
   */
  fill<T extends RankFillRecord>(
    leaderboardId: string,
    expiryUnix: number,
    records: readonly T[],
    enableRanks: boolean,
  ): number {
    if (!enableRanks || !this.#allowed(leaderboardId)) return 0;
    const board = this.#boards.get(keyOf(leaderboardId, expiryUnix));
    if (board === undefined) return 0;
    for (const record of records) {
      const index = this.#indexOf(board, record.ownerId);
      record.rank = index === -1 ? 0 : index + 1;
    }
    return board.entries.length;
  }

  /** 删掉一条记录；这一期压根不在缓存里也算成功（与上游一致）。 */
  delete(leaderboardId: string, expiryUnix: number, ownerId: string): boolean {
    if (!this.#allowed(leaderboardId)) return false;
    const board = this.#boards.get(keyOf(leaderboardId, expiryUnix));
    if (board === undefined) return true;
    const index = this.#indexOf(board, ownerId);
    if (index !== -1) board.entries.splice(index, 1);
    return true;
  }

  deleteLeaderboard(leaderboardId: string, expiryUnix: number): boolean {
    if (!this.#allowed(leaderboardId)) return false;
    this.#boards.delete(keyOf(leaderboardId, expiryUnix));
    return true;
  }

  /** 清掉所有"这一期已经过期"的缓存（`expiry != 0 && expiry <= now`）。 */
  trimExpired(nowUnix: number): boolean {
    if (this.#blacklistAll) return false;
    for (const key of [...this.#boards.keys()]) {
      const expiry = Number(key.slice(key.indexOf("\u0000") + 1));
      if (expiry !== 0 && expiry <= nowUnix) this.#boards.delete(key);
    }
    return true;
  }

  /** 这一期缓存里的条目数（`Fill` 的返回值，也是 `RankCount`）。 */
  count(leaderboardId: string, expiryUnix: number): number {
    if (!this.#allowed(leaderboardId)) return 0;
    return this.#boards.get(keyOf(leaderboardId, expiryUnix))?.entries.length ?? 0;
  }

  /** 清空整张缓存（只给测试用工装使用；生产路径靠 `trimExpired`）。 */
  clear(): void {
    this.#boards.clear();
  }
}
