/**
 * 匹配器统计：`GET /v2/matchmaker/stats` 背后的那份快照。
 *
 * 上游 `LocalMatchmaker` 每轮 `Process` 结束时都会重算一份 `api.MatchmakerStats`
 * 并交给 `OnStatsUpdate`；完成样本只留**最近 10 条**（`NewBuffer(10)`，写满之后
 * 整体左移，把最老的一条挤出去）。这两条都要照抄：
 *
 * - `ticket_count` 是**整池**的票数（不是"活跃票"数）；
 * - `oldest_ticket_create_time` 在池子为空时**不设**（JSON 里就没有这个键），
 *   不是"零值时间戳"——差一秒都不算复刻。
 *
 * 契约源（机器可读）：
 * 契约源: server/matchmaker.go::LocalMatchmaker.Process
 * 契约源: server/matchmaker.go::LocalMatchmaker.GetStats
 *
 * REQ-0001-017
 */

/** 上游 `MatchmakerStatsEntry`：一次成局的"票创建时间 / 完成时间"。 */
export interface MatchmakerCompletion {
  readonly createdAt: number;
  readonly completedAt: number;
}

export interface MatchmakerStats {
  readonly ticketCount: number;
  readonly oldestTicketCreateTime: number | null;
  readonly completions: readonly MatchmakerCompletion[];
}

/** 上游 `Buffer[MatchmakerStatsEntry]{cap: 10}`。 */
export class CompletionBuffer {
  readonly #values: MatchmakerCompletion[] = [];

  constructor(readonly capacity = 10) {}

  insert(entry: MatchmakerCompletion): void {
    if (this.#values.length < this.capacity) {
      this.#values.push(entry);
      return;
    }
    for (let index = 0; index < this.#values.length - 1; index += 1) {
      this.#values[index] = this.#values[index + 1] as MatchmakerCompletion;
    }
    this.#values[this.#values.length - 1] = entry;
  }

  clone(): readonly MatchmakerCompletion[] {
    return [...this.#values];
  }
}

export function statsOf(
  oldestTicketCreateTime: number | null,
  ticketCount: number,
  completions: CompletionBuffer,
): MatchmakerStats {
  return { ticketCount, oldestTicketCreateTime, completions: completions.clone() };
}

/** 池子里最老的一张票的创建时间；空池返回 null（上游不设该字段）。 */
export function oldestCreateTime(createdAtValues: readonly number[]): number | null {
  if (createdAtValues.length === 0) return null;
  return Math.min(...createdAtValues);
}
