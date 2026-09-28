import {
  DEFAULT_MATCHMAKER_CONFIG,
  MatchmakerPool,
  type MatchmakerConfig,
} from "../../src/domain/matchmaker/pool";
import { processPool } from "../../src/domain/matchmaker/process";
import type { MatchmakerIndex, MatchmakerPresence } from "../../src/domain/matchmaker/types";

/**
 * 匹配池的测试工装：把上游测试里那一长串 `Add(...)` 参数收成一个对象。
 *
 * 上游每条用例都手写 12 个参数；搬过来时保持同样的"一次 add = 一张票"的形状，
 * 才能一眼看出哪条用例在测什么。票号（ticket）由工装自己递增生成，
 * 因为上游的断言从不依赖具体的 uuid。
 */

export interface AddTicket {
  readonly sessionId: string;
  /** 派对票：同一派对里多个成员共用一张票。 */
  readonly members?: readonly string[];
  readonly partyId?: string;
  readonly query: string;
  readonly minCount: number;
  readonly maxCount: number;
  readonly countMultiple?: number;
  readonly strings?: Readonly<Record<string, string>>;
  readonly numbers?: Readonly<Record<string, number>>;
  /** 显式指定创建时间（毫秒），用来钉"先来后到"的顺序。 */
  readonly createdAt?: number;
}

export function presenceOf(sessionId: string): MatchmakerPresence {
  return { userId: `u-${sessionId}`, sessionId, username: sessionId, node: "muster" };
}

export class MatchmakerRig {
  readonly pool: MatchmakerPool;
  #seq = 0;

  constructor(config: Partial<MatchmakerConfig> = {}) {
    this.pool = new MatchmakerPool({ ...DEFAULT_MATCHMAKER_CONFIG, ...config });
  }

  add(input: AddTicket): MatchmakerIndex {
    this.#seq += 1;
    const members = input.members ?? [input.sessionId];
    return this.pool.add({
      ticket: `ticket-${this.#seq}`,
      presences: members.map(presenceOf),
      sessionId: input.partyId === undefined ? input.sessionId : "",
      partyId: input.partyId ?? "",
      query: input.query,
      minCount: input.minCount,
      maxCount: input.maxCount,
      countMultiple: input.countMultiple ?? 1,
      stringProperties: input.strings ?? {},
      numericProperties: input.numbers ?? {},
      now: input.createdAt ?? this.#seq,
    });
  }

  /** 跑一轮成局；返回每一局里"参与者的会话 id"分组，顺序与成局顺序一致。 */
  process(): string[][] {
    const { matches } = processPool(this.pool, { mutualMatchBudgetMs: 60_000, now: Date.now() });
    // 组内顺序：上游是"先命中的候选、再发起方"，这里拍平成会话 id 后排序——
    // 断言关心的是"谁和谁配上了"，不是谁排在前面。
    const groups = matches.map((group) =>
      group
        .flatMap((index) => index.sessionIds.map((sessionId) => sessionId))
        .sort((left, right) => (left < right ? -1 : 1)),
    );
    // 成局的票从池子里摘掉（上游 `Process` 结束时那一批 `delete(m.indexes, ...)`）。
    this.pool.remove(matches.flatMap((group) => group.map((index) => index.ticket)));
    return groups;
  }

  /** 一场成局里所有人的会话 id（拍平），便于整表比对。 */
  tickets(): readonly MatchmakerIndex[] {
    return this.pool.tickets();
  }
}

/** 把一组成局拍平成"参与过的会话 id 集合"，断言"谁和谁配上了"时读起来更清楚。 */
export function flat(groups: readonly (readonly string[])[]): string[] {
  return groups.flatMap((group) => [...group]).sort();
}
