import { describe, expect, it } from "vitest";

import { groupIndexes, processPool } from "../../../src/domain/matchmaker/process";
import { MatchmakerPool } from "../../../src/domain/matchmaker/pool";
import type { MatchmakerIndex } from "../../../src/domain/matchmaker/types";
import { MatchmakerRig } from "../../helpers/matchmaker-world";

/**
 * M7 DoD 3/4/5/6/7：成局规则。
 *
 * 上游的这些用例都跑在 `RevPrecision = true` 的池子上（`createTestMatchmaker` 把它
 * 打开、`IntervalSec` 调到 1 秒、`MaxIntervals` 调到 5），所以工装这里也照同样的配置
 * 建池子——**互配判定是这一批用例的主角之一**，默认配置下它是关的。
 *
 * 溯源: server/matchmaker_test.go::TestMatchmakerAddAndRemove
 * 溯源: server/matchmaker_test.go::TestMatchmakerAddWithBasicMatch
 * 溯源: server/matchmaker_test.go::TestMatchmakerAddWithMatchOnStar
 * 溯源: server/matchmaker_test.go::TestMatchmakerAddRemoveNotMatch
 * 溯源: server/matchmaker_test.go::TestMatchmakerAddButNotMatch
 * 溯源: server/matchmaker_test.go::TestMatchmakerAddWithMatchOnRange
 * 溯源: server/matchmaker_test.go::TestMatchmakerAddButNotMatchOnRange
 * 溯源: server/matchmaker_test.go::TestMatchmakerAddWithMatchOnRangeAndValue
 * 溯源: server/matchmaker_test.go::TestMatchmakerAddButNotMatchOnRangeAndValue
 * 溯源: server/matchmaker_test.go::TestMatchmakerAddMultipleAndSomeMatch
 * 溯源: server/matchmaker_test.go::TestMatchmakerAddMultipleAndSomeMatchWithBoost
 * 溯源: server/matchmaker_test.go::TestMatchmakerAddMultipleAndSomeMatchOptionalTextAlteringScore
 * 溯源: server/matchmaker_test.go::TestMatchmakerRequireMutualMatch
 * 溯源: server/matchmaker_test.go::TestMatchmakerRequireMutualMatchLarger
 * 溯源: server/matchmaker_test.go::TestMatchmakerRequireMutualMatchLargerReversed
 * 溯源: server/matchmaker_test.go::TestGroupIndexes
 */

function rig(): MatchmakerRig {
  return new MatchmakerRig({ revPrecision: true, intervalSec: 1, maxIntervals: 5 });
}

describe("M7 成局: 基础", () => {
  it("test_two_tickets_that_satisfy_each_other_form_one_match", () => {
    const pool = rig();
    pool.add({ sessionId: "a", query: "properties.a3:bar", minCount: 2, maxCount: 2, strings: { a3: "baz" } });
    pool.add({ sessionId: "b", query: "properties.a3:baz", minCount: 2, maxCount: 2, strings: { a3: "bar" } });

    expect(pool.process()).toEqual([["a", "b"]]);
    expect(pool.tickets()).toHaveLength(0);
  });

  it("test_star_query_matches_any_other_ticket", () => {
    const pool = rig();
    pool.add({ sessionId: "a", query: "*", minCount: 2, maxCount: 2, strings: { a3: "baz" } });
    pool.add({ sessionId: "b", query: "*", minCount: 2, maxCount: 2, strings: { a3: "bar" } });

    expect(pool.process()).toEqual([["a", "b"]]);
  });

  it("test_a_ticket_can_be_added_and_removed_without_matching", () => {
    const pool = rig();
    const ticket = pool.add({
      sessionId: "a",
      query: "properties.a1:foo",
      minCount: 2,
      maxCount: 2,
      strings: { a1: "bar" },
    });
    pool.pool.removeSession("a", ticket.ticket);

    expect(pool.process()).toEqual([]);
  });

  it("test_a_removed_ticket_no_longer_matches", () => {
    const pool = rig();
    const first = pool.add({ sessionId: "a", query: "properties.a3:bar", minCount: 2, maxCount: 2, strings: { a3: "baz" } });
    pool.add({ sessionId: "b", query: "properties.a3:baz", minCount: 2, maxCount: 2, strings: { a3: "bar" } });
    pool.pool.removeSession("a", first.ticket);

    expect(pool.process()).toEqual([]);
  });

  it("test_tickets_whose_queries_do_not_match_each_other_stay_in_the_pool", () => {
    const pool = rig();
    pool.add({ sessionId: "a", query: "properties.a5:bar", minCount: 2, maxCount: 2, strings: { a5: "baz" } });
    pool.add({ sessionId: "b", query: "properties.a5:bar", minCount: 2, maxCount: 2, strings: { a5: "baz" } });

    expect(pool.process()).toEqual([]);
    expect(pool.tickets()).toHaveLength(2);
  });
});

describe("M7 成局: 数值区间", () => {
  const RANGE = "+properties.b1:>=10 +properties.b1:<=20";

  it("test_two_tickets_inside_the_same_range_match", () => {
    const pool = rig();
    pool.add({ sessionId: "a", query: RANGE, minCount: 2, maxCount: 2, numbers: { b1: 15 } });
    pool.add({ sessionId: "b", query: RANGE, minCount: 2, maxCount: 2, numbers: { b1: 15 } });

    expect(pool.process()).toEqual([["a", "b"]]);
  });

  it("test_tickets_outside_the_range_do_not_match", () => {
    const pool = rig();
    pool.add({ sessionId: "a", query: RANGE, minCount: 2, maxCount: 2, numbers: { b1: 25 } });
    pool.add({ sessionId: "b", query: RANGE, minCount: 2, maxCount: 2, numbers: { b1: 5 } });

    expect(pool.process()).toEqual([]);
  });

  it("test_range_plus_a_text_property_matches", () => {
    const pool = rig();
    const query = "+properties.c1:>=10 +properties.c1:<=20 +properties.c2:foo";
    pool.add({
      sessionId: "a",
      query,
      minCount: 2,
      maxCount: 2,
      strings: { c2: "foo" },
      numbers: { c1: 15 },
    });
    pool.add({
      sessionId: "b",
      query,
      minCount: 2,
      maxCount: 2,
      strings: { c2: "foo" },
      numbers: { c1: 15 },
    });

    expect(pool.process()).toEqual([["a", "b"]]);
  });

  it("test_range_plus_a_text_property_does_not_match_when_the_number_is_outside", () => {
    const pool = rig();
    const query = "+properties.c3:>=10 +properties.c3:<=20 +properties.c4:foo";
    pool.add({
      sessionId: "a",
      query,
      minCount: 2,
      maxCount: 2,
      strings: { c4: "foo" },
      numbers: { c3: 25 },
    });
    pool.add({
      sessionId: "b",
      query,
      minCount: 2,
      maxCount: 2,
      strings: { c4: "foo" },
      numbers: { c3: 5 },
    });

    expect(pool.process()).toEqual([]);
  });
});

describe("M7 成局: 名额与权重", () => {
  it("test_only_one_pair_forms_when_three_tickets_compete_for_two_slots", () => {
    const pool = rig();
    const query = "properties.a6:bar +properties.id:shared";
    for (const sessionId of ["a", "b", "c"]) {
      pool.add({
        sessionId,
        query,
        minCount: 2,
        maxCount: 2,
        strings: { id: "shared", a6: "bar" },
      });
    }

    const groups = pool.process();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
    expect(pool.tickets()).toHaveLength(1);
  });

  it("test_the_highest_boosted_pair_wins_the_slot", () => {
    const pool = rig();
    const near = "properties.n1:<10^10 properties.a6:bar +properties.id:shared";
    const far = "properties.n1:>10^10 properties.a6:bar +properties.id:shared";
    pool.add({
      sessionId: "a",
      query: near,
      minCount: 2,
      maxCount: 2,
      strings: { id: "shared", a6: "bar" },
      numbers: { n1: 5 },
    });
    pool.add({
      sessionId: "b",
      query: far,
      minCount: 2,
      maxCount: 2,
      strings: { id: "shared", a6: "bar" },
      numbers: { n1: 15 },
    });
    pool.add({
      sessionId: "c",
      query: near,
      minCount: 2,
      maxCount: 2,
      strings: { id: "shared", a6: "bar" },
      numbers: { n1: 5 },
    });

    const groups = pool.process();
    expect(groups).toHaveLength(1);
    // 高分的一对被选中：a 与 c（`n1:<10^10` 对 n1=5 有 10 分），b 留在池子里。
    expect([...(groups[0] as string[])].sort()).toEqual(["a", "c"]);
    expect(pool.tickets().flatMap((index) => index.sessionIds)).toEqual(["b"]);
  });

  it("test_optional_text_clauses_alter_the_order_but_not_the_count", () => {
    const pool = rig();
    const query = "properties.a6:bar properties.a6:foo +properties.id:shared";
    pool.add({ sessionId: "a", query, minCount: 2, maxCount: 2, strings: { id: "shared", a6: "bar" } });
    pool.add({ sessionId: "b", query, minCount: 2, maxCount: 2, strings: { id: "shared", a6: "foo" } });
    pool.add({ sessionId: "c", query, minCount: 2, maxCount: 2, strings: { id: "shared", a6: "bar" } });

    const groups = pool.process();
    expect(groups).toHaveLength(1);
    expect(pool.tickets()).toHaveLength(1);
  });
});

describe("M7 成局: 互配", () => {
  it("test_a_one_sided_query_never_forms_a_match", () => {
    const pool = rig();
    // a 找"属性是 bar"的人；b 的属性确实是 bar，但 b 找的是"属性是 zzz"的人，
    // 而 a 的属性是 baz —— 单向满足，不成局。
    pool.add({ sessionId: "a", query: "properties.a6:bar", minCount: 2, maxCount: 2, strings: { a6: "baz" } });
    pool.add({ sessionId: "b", query: "properties.a6:zzz", minCount: 2, maxCount: 2, strings: { a6: "bar" } });

    expect(pool.process()).toEqual([]);
    expect(pool.tickets()).toHaveLength(2);
  });

  it("test_mutual_queries_form_a_match", () => {
    const pool = rig();
    pool.add({ sessionId: "a", query: "properties.a6:bar", minCount: 2, maxCount: 2, strings: { a6: "foo" } });
    pool.add({ sessionId: "b", query: "properties.a6:foo", minCount: 2, maxCount: 2, strings: { a6: "bar" } });

    expect(pool.process()).toEqual([["a", "b"]]);
  });
});

describe("M7 成局: 组合枚举 groupIndexes", () => {
  function index(ticket: string, count: number, createdAt: number): MatchmakerIndex {
    return {
      ticket,
      query: "*",
      parsed: { source: "*", clauses: [], matchAll: true },
      minCount: count,
      maxCount: count,
      countMultiple: 1,
      partyId: "",
      sessionId: ticket,
      sessionIds: [ticket],
      node: "muster",
      createdAt,
      count,
      properties: {},
      stringProperties: {},
      numericProperties: {},
      intervals: 0,
      entries: [],
    };
  }

  it("test_group_indexes_enumerates_every_combination_of_the_required_size", () => {
    const indexes = [
      index("a", 1, 100),
      index("b", 2, 110),
      index("c", 1, 120),
      index("d", 1, 130),
      index("e", 3, 140),
      index("f", 2, 150),
    ];

    const groups = groupIndexes(indexes, 2).map(
      ([members, average]) => `${members.map((member) => member.ticket).join("")}:${average}`,
    );
    expect(groups).toEqual(["ca:110", "da:115", "b:110", "dc:125", "f:150"]);
  });

  it("test_group_indexes_ignores_tickets_larger_than_the_requirement", () => {
    const groups = groupIndexes([index("big", 5, 1), index("small", 1, 2)], 2);
    expect(groups).toHaveLength(0);
    // 池子本身不参与这条断言；留一个空池只为了让"没有可用的组合"与"池子为空"分开。
    expect(new MatchmakerPool().size).toBe(0);
  });
});
