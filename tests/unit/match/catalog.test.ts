import { describe, expect, it } from "vitest";

import { listMatches, type MatchRecord } from "../../../src/domain/match/catalog";

/**
 * M7 契约：`GET /v2/match` 的筛选与排序（上游 `LocalMatchRegistry.ListMatches`）。
 *
 * 三条必须照抄的规矩：
 *   1. **`query` 优先于 `label`**：上游只要 queryString 不是 nil，整条 label 分支就不执行；
 *   2. 给了 `label` 或 `query` 就**只看权威对局**（上游那个 `allowRelayed` 开关）；
 *      `authoritative=false` 与它们同时出现时上游直接早返回空表；
 *   3. 排序是 `-_score, -create_time`（查询分支）或 `-create_time`（标签分支），
 *      且权威对局永远排在前面；本项目补 `match_id` 升序决胜（ECN-0011 偏差 8）。
 *
 * 契约源（机器可读）：
 * 契约源: server/match_registry.go::LocalMatchRegistry.ListMatches
 *
 * REQ-0001-018
 */

function record(overrides: Partial<MatchRecord> & { matchId: string }): MatchRecord {
  return {
    authoritative: true,
    label: "",
    size: 0,
    createTime: 100,
    node: "muster",
    ...overrides,
  };
}

const FILTERS = {
  limit: 10,
  authoritative: undefined,
  label: undefined,
  minSize: undefined,
  maxSize: undefined,
  query: undefined,
} as const;

describe("M7 对局目录: 筛选", () => {
  it("test_limit_zero_short_circuits", () => {
    expect(listMatches([record({ matchId: "a" })], { ...FILTERS, limit: 0 })).toEqual([]);
  });

  it("test_authoritative_true_only_keeps_authoritative_matches", () => {
    const records = [
      record({ matchId: "a", authoritative: true }),
      record({ matchId: "b", authoritative: false, label: "" }),
    ];
    expect(listMatches(records, { ...FILTERS, authoritative: true }).map((r) => r.matchId)).toEqual([
      "a",
    ]);
    expect(listMatches(records, { ...FILTERS, authoritative: false }).map((r) => r.matchId)).toEqual([
      "b",
    ]);
    expect(listMatches(records, FILTERS)).toHaveLength(2);
  });

  it("test_label_is_an_exact_string_match", () => {
    // 上游用的是 keyword 项查询：`label-part2` 不会被分词器切成两个词。
    const records = [
      record({ matchId: "a", label: "label-part2" }),
      record({ matchId: "b", label: "label-part3" }),
      record({ matchId: "c", label: '{"label": "label-part2"}' }),
    ];
    expect(listMatches(records, { ...FILTERS, label: "label-part2" }).map((r) => r.matchId)).toEqual([
      "a",
    ]);
  });

  it("test_query_takes_precedence_over_label", () => {
    // 上游用例里 `label="label"` 与 `query="+label.skill:>=50"` 是同时给的，
    // 而命中的那条标签是 `{"skill":60}`——两者不可能同时成立，只能是 query 生效。
    const records = [record({ matchId: "a", label: '{"skill":60}' })];
    expect(
      listMatches(records, { ...FILTERS, label: "label", query: "+label.skill:>=50" }).map(
        (r) => r.matchId,
      ),
    ).toEqual(["a"]);
  });

  it("test_star_query_matches_every_authoritative_match", () => {
    const records = [record({ matchId: "a", label: '{"skill":60}' })];
    expect(listMatches(records, { ...FILTERS, query: "*" }).map((r) => r.matchId)).toEqual(["a"]);
  });

  it("test_a_label_or_query_filter_drops_relayed_matches", () => {
    const records = [
      record({ matchId: "authoritative", authoritative: true, label: '{"skill":60}' }),
      record({ matchId: "relayed", authoritative: false, label: "" }),
    ];
    expect(
      listMatches(records, { ...FILTERS, query: "+label.skill:>=50" }).map((r) => r.matchId),
    ).toEqual(["authoritative"]);
    // 过滤器 + `authoritative=false`：上游在进去之前就返回空表。
    expect(listMatches(records, { ...FILTERS, authoritative: false, query: "*" })).toEqual([]);
    expect(listMatches(records, { ...FILTERS, authoritative: false, label: "" })).toEqual([]);
  });

  it("test_size_bounds_are_inclusive", () => {
    const records = [
      record({ matchId: "a", size: 1 }),
      record({ matchId: "b", size: 3 }),
      record({ matchId: "c", size: 5 }),
    ];
    expect(listMatches(records, { ...FILTERS, minSize: 3 }).map((r) => r.matchId)).toEqual(["b", "c"]);
    expect(listMatches(records, { ...FILTERS, maxSize: 3 }).map((r) => r.matchId)).toEqual(["a", "b"]);
    expect(
      listMatches(records, { ...FILTERS, minSize: 3, maxSize: 3 }).map((r) => r.matchId),
    ).toEqual(["b"]);
  });
});

describe("M7 对局目录: 排序与截断", () => {
  it("test_newer_matches_come_first_and_match_id_breaks_ties", () => {
    const records = [
      record({ matchId: "b", createTime: 100 }),
      record({ matchId: "a", createTime: 100 }),
      record({ matchId: "c", createTime: 200 }),
    ];
    expect(listMatches(records, FILTERS).map((r) => r.matchId)).toEqual(["c", "a", "b"]);
  });

  it("test_higher_scores_come_first_when_a_query_is_given", () => {
    const records = [
      record({ matchId: "low", label: '{"baz": 1}', createTime: 300 }),
      record({ matchId: "high", label: '{"baz": 9}', createTime: 100 }),
    ];
    const result = listMatches(records, {
      ...FILTERS,
      query: "+label.baz:>=0 label.baz:9^10",
    });
    expect(result.map((r) => r.matchId)).toEqual(["high", "low"]);
  });

  it("test_authoritative_matches_are_listed_before_relayed_ones", () => {
    const records = [
      record({ matchId: "relayed-new", authoritative: false, createTime: 900 }),
      record({ matchId: "authoritative-old", authoritative: true, createTime: 100 }),
    ];
    expect(listMatches(records, FILTERS).map((r) => r.matchId)).toEqual([
      "authoritative-old",
      "relayed-new",
    ]);
  });

  it("test_limit_truncates_after_sorting", () => {
    const records = [
      record({ matchId: "a", createTime: 100 }),
      record({ matchId: "b", createTime: 200 }),
      record({ matchId: "c", createTime: 300 }),
    ];
    expect(listMatches(records, { ...FILTERS, limit: 2 }).map((r) => r.matchId)).toEqual(["c", "b"]);
  });
});
