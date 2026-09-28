/**
 * 匹配池：票的存取与簿记。
 *
 * 上游 `LocalMatchmaker` 把三张表塞在同一个结构里：`indexes`（全池）、
 * `sessionTickets`（会话 → 票）、`partyTickets`（派对 → 票）。这里保持同样的三分，
 * 但把"谁该被选中"留给了 `process.ts`——**存取**与**成局**是两件事，能分开测
 * （上游的 `TestMatchmakerAddOnly` / `RemoveRepeated` 只碰前者）。
 *
 * 两处容易踩的细节：
 * 1. `Add` 的校验顺序是"查询串 → 重复会话 → 上限"（上游就是这样写的），
 *    顺序本身可观测：一张既畸形又超限的票，报的是查询串错误；
 * 2. 派对票（`partyId != ""`）**只能**由 `RemoveParty` 撤，会话票**只能**由
 *    `RemoveSession` 撤——上游用 `index.PartyId` / `index.SessionID` 做这道互斥，
 *    防止用户撤掉自己派对里别人发起的票。
 *
 * 契约源（机器可读）：
 * 契约源: server/matchmaker.go::LocalMatchmaker.Add
 * 契约源: server/matchmaker.go::LocalMatchmaker.Insert
 * 契约源: server/matchmaker.go::LocalMatchmaker.RemoveSession
 * 契约源: server/matchmaker.go::LocalMatchmaker.RemoveParty
 * 契约源: server/matchmaker.go::LocalMatchmaker.Extract
 *
 * REQ-0001-017
 */

import { MatchmakerError } from "./errors";
import { parseMatchmakerQuery } from "./query";
import {
  mergeProperties,
  type AddTicketInput,
  type MatchmakerEntry,
  type MatchmakerExtract,
  type MatchmakerIndex,
} from "./types";

/** 上游 `Matchmaker` 配置段的四个可用旋钮（默认值与上游一致）。 */
export interface MatchmakerConfig {
  readonly maxTickets: number;
  readonly intervalSec: number;
  readonly maxIntervals: number;
  readonly revPrecision: boolean;
  readonly revThreshold: number;
}

export const DEFAULT_MATCHMAKER_CONFIG: MatchmakerConfig = {
  maxTickets: 3,
  intervalSec: 15,
  maxIntervals: 2,
  revPrecision: false,
  revThreshold: 1,
};

function indexFromExtract(extract: MatchmakerExtract): MatchmakerIndex {
  const properties = mergeProperties(extract.stringProperties, extract.numericProperties);
  return {
    ticket: extract.ticket,
    query: extract.query,
    parsed: parseMatchmakerQuery(extract.query),
    minCount: extract.minCount,
    maxCount: extract.maxCount,
    countMultiple: extract.countMultiple,
    partyId: extract.partyId,
    sessionId: extract.sessionId,
    sessionIds: extract.presences.map((presence) => presence.sessionId),
    node: extract.node,
    createdAt: extract.createdAt,
    count: extract.presences.length,
    properties,
    stringProperties: extract.stringProperties,
    numericProperties: extract.numericProperties,
    intervals: extract.intervals,
    entries: extract.presences.map((presence) => ({
      ticket: extract.ticket,
      presence,
      properties,
      partyId: extract.partyId,
      createTime: extract.createdAt,
      stringProperties: extract.stringProperties,
      numericProperties: extract.numericProperties,
    })),
  };
}

export class MatchmakerPool {
  readonly #indexes = new Map<string, MatchmakerIndex>();
  readonly #sessionTickets = new Map<string, Set<string>>();
  readonly #partyTickets = new Map<string, Set<string>>();

  constructor(readonly config: MatchmakerConfig = DEFAULT_MATCHMAKER_CONFIG) {}

  get size(): number {
    return this.#indexes.size;
  }

  get(ticket: string): MatchmakerIndex | undefined {
    return this.#indexes.get(ticket);
  }

  tickets(): readonly MatchmakerIndex[] {
    return [...this.#indexes.values()];
  }

  sessionTickets(sessionId: string): readonly string[] {
    return [...(this.#sessionTickets.get(sessionId) ?? [])];
  }

  partyTickets(partyId: string): readonly string[] {
    return [...(this.#partyTickets.get(partyId) ?? [])];
  }

  /** 上游 `Add`：校验 → 建票 → 记账。返回新建的索引。 */
  add(input: AddTicketInput): MatchmakerIndex {
    const parsed = (() => {
      try {
        return parseMatchmakerQuery(input.query);
      } catch {
        throw new MatchmakerError("query-invalid");
      }
    })();

    const sessionIds = new Set<string>();
    for (const presence of input.presences) {
      if (sessionIds.has(presence.sessionId)) throw new MatchmakerError("duplicate-session");
      sessionIds.add(presence.sessionId);
    }

    for (const presence of input.presences) {
      if (this.sessionTickets(presence.sessionId).length >= this.config.maxTickets) {
        throw new MatchmakerError("too-many-tickets");
      }
    }
    if (input.partyId !== "" && this.partyTickets(input.partyId).length >= this.config.maxTickets) {
      throw new MatchmakerError("too-many-tickets");
    }

    const index = indexFromExtract({
      ticket: input.ticket,
      presences: input.presences,
      sessionId: input.sessionId,
      partyId: input.partyId,
      query: input.query,
      minCount: input.minCount,
      maxCount: input.maxCount,
      countMultiple: input.countMultiple,
      stringProperties: input.stringProperties,
      numericProperties: input.numericProperties,
      intervals: 0,
      createdAt: input.now,
      node: "muster",
    });
    // 解析已经在上面做过一次，这里只是把它接回来，避免同一串被解析两遍走岔。
    this.#indexes.set(index.ticket, { ...index, parsed });
    this.#record(index);
    return this.#indexes.get(index.ticket) as MatchmakerIndex;
  }

  /**
   * 上游 `Insert`：批量灌入（从持久层恢复时也走这里）。
   * 对单张票的失败**静默跳过**（上游只记日志），因为调用方是"恢复"而不是"接收用户输入"。
   */
  insert(extracts: readonly MatchmakerExtract[]): readonly string[] {
    const skipped: string[] = [];
    for (const extract of extracts) {
      try {
        const index = indexFromExtract(extract);
        this.#indexes.set(index.ticket, index);
        this.#record(index);
      } catch {
        skipped.push(extract.ticket);
      }
    }
    return skipped;
  }

  #record(index: MatchmakerIndex): void {
    for (const sessionId of index.sessionIds) {
      const tickets = this.#sessionTickets.get(sessionId) ?? new Set<string>();
      tickets.add(index.ticket);
      this.#sessionTickets.set(sessionId, tickets);
    }
    if (index.partyId !== "") {
      const tickets = this.#partyTickets.get(index.partyId) ?? new Set<string>();
      tickets.add(index.ticket);
      this.#partyTickets.set(index.partyId, tickets);
    }
  }

  #forget(index: MatchmakerIndex): void {
    for (const sessionId of index.sessionIds) {
      const tickets = this.#sessionTickets.get(sessionId);
      if (tickets === undefined) continue;
      tickets.delete(index.ticket);
      if (tickets.size === 0) this.#sessionTickets.delete(sessionId);
    }
    if (index.partyId !== "") {
      const tickets = this.#partyTickets.get(index.partyId);
      if (tickets === undefined) return;
      tickets.delete(index.ticket);
      if (tickets.size === 0) this.#partyTickets.delete(index.partyId);
    }
  }

  /** 会话撤自己的票。票不存在、或那是张派对票 → `ticket-not-found`。 */
  removeSession(sessionId: string, ticket: string): void {
    const index = this.#indexes.get(ticket);
    if (index === undefined || index.partyId !== "" || index.sessionId !== sessionId) {
      throw new MatchmakerError("ticket-not-found");
    }
    this.#indexes.delete(ticket);
    this.#forget(index);
  }

  /** 派对主持人撤派对票。票不存在、或那是张会话票 → `ticket-not-found`。 */
  removeParty(partyId: string, ticket: string): void {
    const index = this.#indexes.get(ticket);
    if (index === undefined || index.sessionId !== "" || index.partyId !== partyId) {
      throw new MatchmakerError("ticket-not-found");
    }
    this.#indexes.delete(ticket);
    this.#forget(index);
  }

  /** 会话断开时的清理：撤掉它名下的全部票（幂等，没有票也不报错）。 */
  removeSessionAll(sessionId: string): readonly string[] {
    const tickets = this.sessionTickets(sessionId);
    for (const ticket of tickets) this.removeSession(sessionId, ticket);
    return tickets;
  }

  removePartyAll(partyId: string): readonly string[] {
    const tickets = this.partyTickets(partyId);
    for (const ticket of tickets) this.removeParty(partyId, ticket);
    return tickets;
  }

  /** 成局之后把选中的票摘掉（上游 `Process` 里 `delete(m.indexes, ...)` 那一批）。 */
  remove(tickets: readonly string[]): readonly MatchmakerIndex[] {
    const removed: MatchmakerIndex[] = [];
    for (const ticket of tickets) {
      const index = this.#indexes.get(ticket);
      if (index === undefined) continue;
      this.#indexes.delete(ticket);
      this.#forget(index);
      removed.push(index);
    }
    return removed;
  }

  entriesOf(ticket: string): readonly MatchmakerEntry[] {
    return this.#indexes.get(ticket)?.entries ?? [];
  }
}
