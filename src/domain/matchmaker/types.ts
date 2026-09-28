/**
 * 匹配池的数据形状。
 *
 * 逐字段对齐上游 `server/matchmaker.go` 的 `MatchmakerPresence` / `MatchmakerEntry` /
 * `MatchmakerIndex` / `MatchmakerExtract`（见 ECN-0011 偏差 1）：
 *
 * - `MatchmakerPresence`：一条会话在票面上的身份（用户、会话、用户名、节点）；
 * - `MatchmakerEntry`：presence + 这张票的属性（成局时发给客户端的 `users` 元素）；
 * - `MatchmakerIndex`：池子里的一张票（查询、计数、区间、会话集合、已等待轮数）；
 * - `MatchmakerExtract`：票的"可搬运形状"（跨 DO 边界时就传它）。
 *
 * 时间统一用**毫秒**（上游用纳秒）。票的排序、等待时长都以毫秒比较，纳秒级差异
 * 不会改变任何可观测行为；这条偏差记在 ECN-0011 偏差 9。
 *
 * 契约源（机器可读）：
 * 契约源: server/matchmaker.go::MatchmakerIndex
 * 契约源: server/matchmaker.go::MatchmakerEntry
 * 契约源: server/matchmaker.go::MatchmakerExtract
 *
 * REQ-0001-017
 */

import type { MatchmakerQuery, PropertyValue } from "./query";

export interface MatchmakerPresence {
  readonly userId: string;
  readonly sessionId: string;
  readonly username: string;
  readonly node: string;
}

export interface MatchmakerEntry {
  readonly ticket: string;
  readonly presence: MatchmakerPresence;
  readonly properties: Readonly<Record<string, PropertyValue>>;
  readonly partyId: string;
  readonly createTime: number;
  readonly stringProperties: Readonly<Record<string, string>>;
  readonly numericProperties: Readonly<Record<string, number>>;
}

export interface MatchmakerIndex {
  readonly ticket: string;
  readonly query: string;
  readonly parsed: MatchmakerQuery;
  readonly minCount: number;
  readonly maxCount: number;
  readonly countMultiple: number;
  readonly partyId: string;
  readonly sessionId: string;
  readonly sessionIds: readonly string[];
  readonly node: string;
  readonly createdAt: number;
  readonly count: number;
  readonly properties: Readonly<Record<string, PropertyValue>>;
  readonly stringProperties: Readonly<Record<string, string>>;
  readonly numericProperties: Readonly<Record<string, number>>;
  /**
   * 这一轮之前已经等了几轮（上游 `Intervals`）。
   *
   * **唯一**可变字段：上游 `processDefault` 里那句 `activeIndex.Intervals++` 是就地改的，
   * 本项目保持同样形状，免得"记账"和"选人"之间多一层拷贝（拷贝会让"这一轮数"错位）。
   */
  intervals: number;
  readonly entries: readonly MatchmakerEntry[];
}

/** 票的"可搬运形状"：DO 之间只用它说话，解析后的查询（RegExp）不参与序列化。 */
export interface MatchmakerExtract {
  readonly ticket: string;
  readonly presences: readonly MatchmakerPresence[];
  readonly sessionId: string;
  readonly partyId: string;
  readonly query: string;
  readonly minCount: number;
  readonly maxCount: number;
  readonly countMultiple: number;
  readonly stringProperties: Readonly<Record<string, string>>;
  readonly numericProperties: Readonly<Record<string, number>>;
  readonly intervals: number;
  readonly createdAt: number;
  readonly node: string;
}

export interface AddTicketInput {
  readonly ticket: string;
  readonly presences: readonly MatchmakerPresence[];
  readonly sessionId: string;
  readonly partyId: string;
  readonly query: string;
  readonly minCount: number;
  readonly maxCount: number;
  readonly countMultiple: number;
  readonly stringProperties: Readonly<Record<string, string>>;
  readonly numericProperties: Readonly<Record<string, number>>;
  readonly now: number;
}

/** 合并后的属性表：字符串属性与数值属性拼在一起（上游 `Add` 的第一件事）。 */
export function mergeProperties(
  stringProperties: Readonly<Record<string, string>>,
  numericProperties: Readonly<Record<string, number>>,
): Record<string, PropertyValue> {
  const merged: Record<string, PropertyValue> = {};
  for (const [key, value] of Object.entries(stringProperties)) merged[key] = value;
  for (const [key, value] of Object.entries(numericProperties)) merged[key] = value;
  return merged;
}

export function extractOf(index: MatchmakerIndex): MatchmakerExtract {
  return {
    ticket: index.ticket,
    presences: index.entries.map((entry) => entry.presence),
    sessionId: index.sessionId,
    partyId: index.partyId,
    query: index.query,
    minCount: index.minCount,
    maxCount: index.maxCount,
    countMultiple: index.countMultiple,
    stringProperties: index.stringProperties,
    numericProperties: index.numericProperties,
    intervals: index.intervals,
    createdAt: index.createdAt,
    node: index.node,
  };
}
