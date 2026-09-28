/**
 * 对局目录：`GET /v2/match` 背后的筛选逻辑。
 *
 * 上游 `ListMatches` 有**两条**不同的过滤路径，语义不一样，不能混：
 *
 * - `label`：对 `label_string` 做**整串相等**（bluge 的 keyword 项查询）。
 *   于是 `label=label-part2` 能命中标签恰为 `label-part2` 的对局，
 *   而不会被分词器切成 `label` + `part2` 两个词（上游专门有一条用例钉这件事）；
 * - `query`：把标签当 JSON 解析，对 `label.*` 字段求值（`+label.skill:>=50`）。
 *
 * 两条路径都只对**权威对局**有意义，所以 `authoritative=false` 与它们同时出现时，
 * API 层直接 400（文案在 `src/http/routes/match.ts`）。
 *
 * 两条**容易抄错**的顺序规则：
 *
 * 1. `query` 优先于 `label`：上游 `queryString != nil` 时整条 `label` 分支不会执行，
 *    所以两个参数同时给的时候 `label` 是被忽略的（有一条上游用例两个都给了）；
 * 2. 只要给了 `label` 或 `query`，结果就只从**标签索引**里取——也就是只看权威对局。
 *    上游用 `allowRelayed` 这个开关表达它，`authoritative=false` 时干脆早返回空表。
 *
 * 排序：上游查标签索引时是 `-create_time`，查查询串时是 `-_score, -create_time`，
 * 且**权威对局永远排在前面**（两条来源分别追加）。本项目照抄，并在末尾补
 * `match_id` 升序做决胜——**上游没有这个决胜项**，同秒创建的对局顺序在它那里是
 * 未定义的（ECN-0011 偏差 8）。
 *
 * 契约源（机器可读）：
 * 契约源: server/match_registry.go::LocalMatchRegistry.ListMatches
 * 契约源: server/api_match.go::ApiServer.ListMatches
 *
 * REQ-0001-018
 */

import { matchFields, parseMatchmakerQuery, propertyFields, type PropertyValue } from "../matchmaker/query";

export interface MatchRecord {
  readonly matchId: string;
  readonly authoritative: boolean;
  /** 对局标签，恒为字符串（上游 `label` 包装类型在 JSON 里就是字符串）。 */
  readonly label: string;
  readonly size: number;
  /** 创建时间，Unix 秒。 */
  readonly createTime: number;
  readonly node: string;
}

export interface MatchListFilters {
  readonly limit: number;
  readonly authoritative: boolean | undefined;
  readonly label: string | undefined;
  readonly minSize: number | undefined;
  readonly maxSize: number | undefined;
  readonly query: string | undefined;
}

/** 标签 → 可查询字段。不是合法 JSON 对象时没有字段（查询串没有可命中的东西）。 */
export function labelFields(label: string): ReadonlyMap<string, readonly (string | number | boolean)[]> {
  try {
    const parsed: unknown = JSON.parse(label);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Map();
    const properties: Record<string, PropertyValue> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        Array.isArray(value)
      ) {
        properties[key] = value as PropertyValue;
      }
    }
    return propertyFields(properties, "label.");
  } catch {
    return new Map();
  }
}

export function listMatches(
  records: readonly MatchRecord[],
  filters: MatchListFilters,
): readonly MatchRecord[] {
  if (filters.limit === 0) return [];

  const query = filters.query === undefined ? null : parseMatchmakerQuery(filters.query);
  // 给了 query 就忽略 label（规则 1）；给了其中之一就只看权威对局（规则 2）。
  const label = query === null ? filters.label : undefined;
  const indexOnly = query !== null || label !== undefined;
  if (indexOnly && filters.authoritative === false) return [];
  const authoritative = indexOnly ? true : filters.authoritative;
  const scored: { record: MatchRecord; score: number }[] = [];

  for (const record of records) {
    if (authoritative !== undefined && record.authoritative !== authoritative) continue;
    if (label !== undefined && record.label !== label) continue;
    if (filters.minSize !== undefined && record.size < filters.minSize) continue;
    if (filters.maxSize !== undefined && record.size > filters.maxSize) continue;
    if (query !== null) {
      const result = matchFields(query, labelFields(record.label));
      if (!result.matched) continue;
      scored.push({ record, score: result.score });
      continue;
    }
    scored.push({ record, score: 0 });
  }

  scored.sort((left, right) => {
    if (left.record.authoritative !== right.record.authoritative) {
      return left.record.authoritative ? -1 : 1;
    }
    if (left.score !== right.score) return right.score - left.score;
    if (left.record.createTime !== right.record.createTime) {
      return right.record.createTime - left.record.createTime;
    }
    return left.record.matchId < right.record.matchId ? -1 : 1;
  });

  return scored.slice(0, filters.limit).map((entry) => entry.record);
}
