/**
 * 一轮成局：从池子里挑出可以配对的票。
 *
 * 这是上游 `server/matchmaker_process.go::LocalMatchmaker.processDefault` 的逐条搬运。
 * 上游靠 bluge 做检索（打分 + 按 `created_at` 排序），这里换成"自己遍历 + 自己算分"
 * （ECN-0011 偏差 4：打分只算子句 boost 之和，不实现 bm25/keyword 相关度），但
 * **选人规则一字不改**：
 *
 * 1. 对每张活跃票，先筛出"查询命中 + min/max 相容 + 不含自己派对 + 无会话重叠"的候选，
 *    按分数降序、创建时间升序排列；
 * 2. 把候选逐个塞进"组合"里：填得进已有组合就填，填不进就开一个新组合；
 * 3. 组合够格（凑满 max_count，或者已是最后一轮且满足 min_count 且后面没有更多候选）
 *    时才考虑成局，并且要过 `count_multiple` 裁剪与"组合内每张票自身条件"两道检查；
 * 4. 成局的票从池子里摘掉，同一轮里不再被别的票选中。
 *
 * 分数为什么重要：上游用 `-_score, created_at` 排序，boost 高的子句命中者排在前面。
 * 于是 `label.baz:4^10` 的两张票会先于 `label.baz:2^5` 被选中——上游的
 * `TestMatchmakerAddMultipleAndSomeMatchWithBoost` 就钉着这件事。
 *
 * 确定性：上游遍历 Go map 的次序是随机的，本项目按 (createdAt, ticket) 升序遍历，
 * 结果**只多不少**地确定（ECN-0011 偏差 5）。这不会改变任何一条断言，只会让"同样的
 * 输入得到同样的输出"从"通常成立"变成"总是成立"。
 *
 * 契约源（机器可读）：
 * 契约源: server/matchmaker_process.go::LocalMatchmaker.processDefault
 * 契约源: server/matchmaker.go::groupIndexes
 *
 * REQ-0001-017
 */

import { matchFields, propertyFields } from "./query";
import type { MatchmakerPool } from "./pool";
import type { MatchmakerIndex } from "./types";

export interface ProcessOptions {
  /**
   * 本轮允许用于"反向匹配（互配）"的毫秒预算。超过之后不再做互配校验，
   * 与上游 `processDefault` 里那个 `revThresholdFn` 定时器同义。
   */
  readonly mutualMatchBudgetMs: number;
  /** 现在（毫秒）。可注入，测试与 DO 共用同一份实现。 */
  readonly now: number;
}

export interface ProcessResult {
  readonly matches: readonly (readonly MatchmakerIndex[])[];
  /** 这一轮之后不再作为"发起方"的票（上游 `expiredActiveIndexes`）。 */
  readonly expired: readonly string[];
}

interface Hit {
  readonly index: MatchmakerIndex;
  readonly score: number;
}

interface Combo {
  readonly tickets: MatchmakerIndex[];
  size: number;
}

function hitsOf(
  active: MatchmakerIndex,
  candidates: readonly MatchmakerIndex[],
  selected: ReadonlySet<string>,
): Hit[] {
  const hits: Hit[] = [];
  for (const candidate of candidates) {
    if (candidate.ticket === active.ticket) continue;
    if (selected.has(candidate.ticket)) continue;
    // 上游的 min/max 相容条件：候选必须"装得进"发起方的区间。
    if (!(candidate.minCount >= active.minCount && candidate.maxCount <= active.maxCount)) continue;
    if (active.partyId !== "" && candidate.partyId === active.partyId) continue;
    const result = matchFields(active.parsed, propertyFields(candidate.properties));
    if (!result.matched) continue;
    hits.push({ index: candidate, score: result.score });
  }
  hits.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.index.createdAt !== right.index.createdAt) {
      return left.index.createdAt - right.index.createdAt;
    }
    return left.index.ticket < right.index.ticket ? -1 : 1;
  });
  return hits;
}

function conflicts(a: readonly string[], b: readonly string[]): boolean {
  for (const value of a) {
    if (b.includes(value)) return true;
  }
  return false;
}

/** 上游 `validateMatch`：候选的查询能否命中发起方的属性（互配的另一半）。 */
function mutualMatch(active: MatchmakerIndex, candidate: MatchmakerIndex): boolean {
  return matchFields(candidate.parsed, propertyFields(active.properties)).matched;
}

export function averageCreatedAt(group: readonly MatchmakerIndex[]): number {
  if (group.length === 0) return 0;
  let total = 0;
  for (const index of group) total += index.createdAt;
  return Math.floor(total / group.length);
}

/**
 * 上游 `groupIndexes`：从 `indexes` 里凑出"总人数恰好为 required"的所有组合，
 * 每个组合带一个 avgCreatedAt（加权平均，权重是组合内的**票数**）。
 */
export function groupIndexes(
  indexes: readonly MatchmakerIndex[],
  required: number,
): readonly [MatchmakerIndex[], number][] {
  if (indexes.length === 0 || required <= 0) return [];
  const [current, ...others] = indexes as [MatchmakerIndex, ...MatchmakerIndex[]];

  // 当前票比要求还大：它根本用不上，跳过它继续。
  if (current.count > required) return groupIndexes(others, required);

  const results: [MatchmakerIndex[], number][] = [];
  if (current.count === required) {
    results.push([[current], current.createdAt]);
  } else {
    for (const [fill, fillAverage] of groupIndexes(others, required - current.count)) {
      const count = fill.length;
      const average = Math.floor((fillAverage * count + current.createdAt) / (count + 1));
      results.push([[...fill, current], average]);
    }
  }
  results.push(...groupIndexes(others, required));
  return results;
}

export function processPool(pool: MatchmakerPool, options: ProcessOptions): ProcessResult {
  const config = pool.config;
  const all = [...pool.tickets()].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
    return left.ticket < right.ticket ? -1 : 1;
  });

  const expired: string[] = [];
  const live: MatchmakerIndex[] = [];
  for (const index of all) {
    if (index.intervals >= config.maxIntervals) continue;
    live.push(index);
    // 上游：等满了 max_intervals，或 min == max（再等下去结果一样）就不再主动发起。
    index.intervals += 1;
    if (index.intervals >= config.maxIntervals || index.minCount === index.maxCount) {
      expired.push(index.ticket);
    }
  }

  const deadline = options.now + options.mutualMatchBudgetMs;
  const selected = new Set<string>();
  const matches: MatchmakerIndex[][] = [];

  for (const active of live) {
    if (selected.has(active.ticket)) continue;
    const lastInterval =
      active.intervals >= config.maxIntervals || active.minCount === active.maxCount;
    const useMutual = config.revPrecision && Date.now() < deadline;

    const hits = hitsOf(active, all, selected);

    const combos: Combo[] = [];
    let chosen: Combo | null = null;
    const lastHitCounter = hits.length - 1;

    for (let hitCounter = 0; hitCounter < hits.length; hitCounter += 1) {
      const hit = hits[hitCounter] as Hit;
      const hitIndex = hit.index;

      if (useMutual && !mutualMatch(active, hitIndex)) continue;
      // 上游：候选还想等更大的局，就让它等（除非它已经等不动了）。
      if (active.maxCount < hitIndex.maxCount && hitIndex.intervals <= config.maxIntervals) continue;
      if (conflicts(active.sessionIds, hitIndex.sessionIds)) continue;

      let found: Combo | null = null;
      for (const combo of combos) {
        if (combo.size + hitIndex.count > active.maxCount) continue;
        let clash = false;
        for (const member of combo.tickets) {
          if (conflicts(member.sessionIds, hitIndex.sessionIds)) {
            clash = true;
            break;
          }
          if (useMutual && (!mutualMatch(member, hitIndex) || !mutualMatch(hitIndex, member))) {
            clash = true;
            break;
          }
        }
        if (clash) continue;
        combo.tickets.push(hitIndex);
        combo.size += hitIndex.count;
        found = combo;
        break;
      }
      if (found === null) {
        found = { tickets: [hitIndex], size: hitIndex.count };
        combos.push(found);
      }

      let size = found.size + active.count;
      const filled = size === active.maxCount;
      const bestEffort =
        lastInterval && size >= active.minCount && size <= active.maxCount && hitCounter >= lastHitCounter;
      if (!filled && !bestEffort) continue;

      const remainder = size % active.countMultiple;
      if (remainder !== 0) {
        const eligible = found.tickets.filter((member) => member.count <= remainder);
        const groups = groupIndexes(eligible, remainder);
        if (groups.length === 0) {
          // 裁不出合法组合：把这次塞进去的候选退回去，继续看下一个候选。
          found.tickets.splice(found.tickets.length - 1, 1);
          found.size -= hitIndex.count;
          continue;
        }
        // 优先保留等得最久的人：拿掉平均创建时间最早的那一组。
        const sorted = [...groups].sort((left, right) => left[1] - right[1]);
        const trimmed = (sorted[0] as [MatchmakerIndex[], number])[0];
        for (const drop of trimmed) {
          const at = found.tickets.indexOf(drop);
          if (at < 0) continue;
          found.tickets.splice(at, 1);
          found.size -= drop.count;
        }
        size = found.size + active.count;
        if (size % active.countMultiple !== 0) continue;
      }

      const failed = found.tickets.some(
        (member) =>
          member.minCount > size || member.maxCount < size || size % member.countMultiple !== 0,
      );
      if (failed) continue;

      chosen = found;
      break;
    }

    if (chosen === null) continue;

    const group = [...chosen.tickets, active];
    for (const member of group) selected.add(member.ticket);
    matches.push(group);
  }

  return { matches, expired };
}
