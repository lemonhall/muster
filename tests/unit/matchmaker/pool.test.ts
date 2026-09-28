import { describe, expect, it } from "vitest";

import { MatchmakerError } from "../../../src/domain/matchmaker/errors";
import { MatchmakerPool } from "../../../src/domain/matchmaker/pool";
import { matchProperties, parseMatchmakerQuery } from "../../../src/domain/matchmaker/query";
import { MatchmakerRig } from "../../helpers/matchmaker-world";

/**
 * M7 DoD 1/2/7：查询语言、票的存取、票数上限。
 *
 * 这一批用例对应上游 `server/matchmaker_test.go` 里**不涉及成局**的那几条：
 * 只 Add 不成局、反复 Add/Remove、用正则排除已匹配过的玩家、以及每会话/每派对
 * 的票数上限。它们能过，说明"池子怎么记账"是对的；能不能配上人由 matching 那批管。
 *
 * 溯源: server/matchmaker_test.go::TestMatchmakerAddOnly
 * 溯源: server/matchmaker_test.go::TestMatchmakerAddRemoveRepeated
 * 溯源: server/matchmaker_test.go::TestMatchmakerPropertyRegexSubmatch
 * 溯源: server/matchmaker_test.go::TestMatchmakerPropertyRegexSubmatchMultiple
 * 溯源: server/match_registry_test.go::TestMatchRegistryAuthoritativeMatchAndListMatchesWithQueryingAndBoost
 */

const BLOCKED_A = "4bd6667a-2659-4888-b245-e13690ff4a9b";
const BLOCKED_B = "cc44260e-6b7d-4237-9871-6146d86f7a71";
const BLOCKED_C = "324b7447-ec0f-4b5f-9a13-06511d0bb527";
const BLOCKED_D = "3a3b78a0-8622-4a23-be42-70bfbb26582f";

const BLOCKED_VALUE = `${BLOCKED_A} ${BLOCKED_B} ${BLOCKED_C}`;

describe("M7 匹配池: 查询语言", () => {
  it("test_star_and_empty_query_match_everything", () => {
    const properties = { a1: "bar" };
    expect(matchProperties(parseMatchmakerQuery("*"), properties).matched).toBe(true);
    expect(matchProperties(parseMatchmakerQuery(""), properties).matched).toBe(true);
  });

  it("test_optional_clauses_are_or_while_required_clauses_are_and", () => {
    const query = parseMatchmakerQuery("properties.a6:bar properties.a6:foo +properties.id:abc");
    expect(query.clauses.map((clause) => clause.required)).toEqual([false, false, true]);
    expect(matchProperties(query, { a6: "bar", id: "abc" }).matched).toBe(true);
    expect(matchProperties(query, { a6: "foo", id: "abc" }).matched).toBe(true);
    // required 的那条挂了一切都挂——这一半与"可选子句松不松"无关。
    expect(matchProperties(query, { a6: "bar", id: "other" }).matched).toBe(false);
  });

  it("test_required_clauses_downgrade_optional_clauses_to_scoring_only", () => {
    // 上游那条 boost 用例（match_registry_test.go）钉着这条反直觉的规矩：十条标签里
    // 只有四条能命中 `label.baz:4^10` / `label.baz:2^5`，但十条**全部**返回，
    // 命中者靠分数排到前面。也就是说：只要有一条 `+` 子句，可选子句就不再是门槛。
    const query = parseMatchmakerQuery("+properties.id:abc properties.a6:bar");
    expect(matchProperties(query, { id: "abc", a6: "nope" }).matched).toBe(true);
    expect(matchProperties(query, { id: "other", a6: "bar" }).matched).toBe(false);
    // 反过来，一个 `+` 子句都没有时，"至少命中一条可选子句"才重新成为门槛。
    const optionalOnly = parseMatchmakerQuery("properties.a6:bar properties.a6:foo");
    expect(matchProperties(optionalOnly, { a6: "nope" }).matched).toBe(false);
  });

  it("test_negative_clauses_exclude_matches", () => {
    const query = parseMatchmakerQuery("+properties.game_mode:foo -properties.blocked:zzz");
    expect(matchProperties(query, { game_mode: "foo" }).matched).toBe(true);
    expect(matchProperties(query, { game_mode: "foo", blocked: "zzz" }).matched).toBe(false);
  });

  it("test_numeric_ranges_only_match_numeric_properties", () => {
    const query = parseMatchmakerQuery("+properties.b1:>=10 +properties.b1:<=20");
    expect(matchProperties(query, { b1: 15 }).matched).toBe(true);
    expect(matchProperties(query, { b1: 9 }).matched).toBe(false);
    expect(matchProperties(query, { b1: 21 }).matched).toBe(false);
    // 文本属性不参与数值比较（上游只有数值字段进数值索引）。
    expect(matchProperties(query, { b1: "15" }).matched).toBe(false);

    expect(matchProperties(parseMatchmakerQuery("properties.n1:<10"), { n1: 9 }).matched).toBe(true);
    expect(matchProperties(parseMatchmakerQuery("properties.n1:>10"), { n1: 9 }).matched).toBe(false);
  });

  it("test_boosts_are_summed_into_the_score", () => {
    const query = parseMatchmakerQuery("+label.foo:5 +label.bar:1 label.baz:4^10 label.baz:2^5");
    // 两条 required 子句各自 +1，命中 baz:4 再加 10。
    expect(matchProperties(query, { foo: 5, bar: 1, baz: 4 }, "label.").score).toBe(12);
    expect(matchProperties(query, { foo: 5, bar: 1, baz: 2 }, "label.").score).toBe(7);
    // 两条可选子句一条都没命中：**照样匹配**（有 `+` 子句时可选子句只打分），
    // 分数只剩下两条 required 子句的 1+1。
    const noOptionalHit = matchProperties(query, { foo: 5, bar: 1, baz: 0 }, "label.");
    expect(noOptionalHit.matched).toBe(true);
    expect(noOptionalHit.score).toBe(2);
  });

  it("test_unknown_fields_never_match_but_keep_the_boolean_structure", () => {
    // `properties.id` 没有出现 → required 子句挂了，整条查询就不该命中。
    expect(matchProperties(parseMatchmakerQuery("+properties.id:abc"), { a1: "bar" }).matched).toBe(
      false,
    );
    // 可选子句里引用不存在的字段：别的可选子句还能救回来。
    expect(
      matchProperties(parseMatchmakerQuery("properties.id:abc properties.a1:bar"), { a1: "bar" })
        .matched,
    ).toBe(true);
  });

  it("test_malformed_queries_are_rejected_before_anything_else", () => {
    const rig = new MatchmakerRig();
    expect(() =>
      rig.add({ sessionId: "s1", query: "no-colon-here", minCount: 2, maxCount: 2 }),
    ).toThrowError(MatchmakerError);
    // 校验顺序：查询串排在最前，所以"既畸形又超限"的票报的是查询串。
    expect(() => rig.add({ sessionId: "s1", query: "also-bad", minCount: 1, maxCount: 2 })).toThrowError(
      MatchmakerError,
    );
  });
});

describe("M7 匹配池: 票的存取", () => {
  it("test_add_only_returns_a_ticket", () => {
    const rig = new MatchmakerRig();
    const ticket = rig.add({
      sessionId: "s1",
      query: "properties.a1:foo",
      minCount: 2,
      maxCount: 2,
      strings: { a1: "bar" },
    });
    expect(ticket.ticket).not.toBe("");
    expect(rig.tickets()).toHaveLength(1);
  });

  it("test_add_and_remove_can_be_repeated", () => {
    const rig = new MatchmakerRig();
    for (let round = 0; round < 4; round += 1) {
      const ticket = rig.add({
        sessionId: "s1",
        query: "properties.a1:foo",
        minCount: 2,
        maxCount: 2,
        strings: { a1: "bar" },
      });
      expect(ticket.ticket).not.toBe("");
      rig.pool.removeSession("s1", ticket.ticket);
      expect(rig.pool.sessionTickets("s1")).toHaveLength(0);
    }
    expect(rig.tickets()).toHaveLength(0);
  });

  it("test_a_session_cannot_remove_a_party_ticket_and_vice_versa", () => {
    const rig = new MatchmakerRig();
    const partyTicket = rig.add({
      sessionId: "",
      partyId: "party-1",
      members: ["a", "b"],
      query: "*",
      minCount: 2,
      maxCount: 4,
    });
    expect(() => rig.pool.removeSession("a", partyTicket.ticket)).toThrowError(MatchmakerError);
    rig.pool.removeParty("party-1", partyTicket.ticket);

    const sessionTicket = rig.add({ sessionId: "a", query: "*", minCount: 2, maxCount: 2 });
    expect(() => rig.pool.removeParty("party-1", sessionTicket.ticket)).toThrowError(MatchmakerError);
  });

  it("test_removing_an_unknown_ticket_reports_not_found", () => {
    const rig = new MatchmakerRig();
    expect(() => rig.pool.removeSession("s1", "nope")).toThrowError(MatchmakerError);
  });
});

describe("M7 匹配池: 票数上限", () => {
  it("test_a_session_may_hold_three_tickets_but_not_four", () => {
    const rig = new MatchmakerRig({ maxTickets: 3 });
    for (let index = 0; index < 3; index += 1) {
      rig.add({ sessionId: "s1", query: "*", minCount: 2, maxCount: 2 });
    }
    expect(() => rig.add({ sessionId: "s1", query: "*", minCount: 2, maxCount: 2 })).toThrowError(
      MatchmakerError,
    );
    // 被拒的那张没有占位：撤掉一张之后又能加回来。
    const [first] = rig.pool.sessionTickets("s1");
    rig.pool.removeSession("s1", first as string);
    expect(rig.add({ sessionId: "s1", query: "*", minCount: 2, maxCount: 2 }).ticket).not.toBe("");
  });

  it("test_a_party_may_hold_three_tickets_but_not_four", () => {
    const rig = new MatchmakerRig({ maxTickets: 3 });
    for (let index = 0; index < 3; index += 1) {
      rig.add({
        sessionId: "",
        partyId: "party-1",
        members: ["a"],
        query: "*",
        minCount: 1,
        maxCount: 2,
      });
    }
    expect(() =>
      rig.add({ sessionId: "", partyId: "party-1", members: ["a"], query: "*", minCount: 1, maxCount: 2 }),
    ).toThrowError(MatchmakerError);
  });

  it("test_duplicate_sessions_inside_one_ticket_are_rejected", () => {
    const rig = new MatchmakerRig();
    expect(() =>
      rig.add({ sessionId: "", partyId: "p", members: ["a", "a"], query: "*", minCount: 2, maxCount: 2 }),
    ).toThrowError(MatchmakerError);
  });
});

describe("M7 匹配池: 正则排除", () => {
  /** 上游 `MapMatchmakerIndex` + `Insert`：直接把一张票灌进池子（不走 `Add`）。 */
  function insertBlockedTicket(rig: MatchmakerRig): void {
    rig.pool.insert([
      {
        ticket: "ticket1",
        presences: [{ userId: "a", sessionId: "sid1", username: "a", node: "muster" }],
        sessionId: "sid1",
        partyId: "",
        query: "*",
        minCount: 2,
        maxCount: 2,
        countMultiple: 1,
        stringProperties: { blocked: BLOCKED_VALUE, game_mode: "foo" },
        numericProperties: {},
        intervals: 0,
        createdAt: 1,
        node: "muster",
      },
    ]);
  }

  it("test_regex_exclusion_matches_every_blocked_id_not_present", () => {
    for (const candidate of [BLOCKED_A, BLOCKED_B, BLOCKED_C, BLOCKED_D]) {
      const rig = new MatchmakerRig();
      insertBlockedTicket(rig);
      const ticket = rig.pool.get("ticket1") as unknown as { properties: Record<string, string> };
      const query = parseMatchmakerQuery(
        `+properties.game_mode:foo -properties.blocked:/.*${candidate}.*/`,
      );
      const matched = matchProperties(query, ticket.properties).matched;
      expect(matched).toBe(!BLOCKED_VALUE.includes(candidate));
      expect(matchProperties(parseMatchmakerQuery("+properties.game_mode:bar"), ticket.properties).matched).toBe(
        false,
      );
    }
  });

  it("test_regex_alternation_matches_any_listed_map", () => {
    const rig = new MatchmakerRig();
    insertBlockedTicket(rig);
    const ticket = rig.pool.get("ticket1") as unknown as { properties: Record<string, string> };
    const properties = { ...ticket.properties, maps: "some_map_foo" };
    const query = parseMatchmakerQuery("+properties.game_mode:foo +properties.maps:/.*(map2|map3).*/");
    expect(matchProperties(query, properties).matched).toBe(false);
    expect(
      matchProperties(
        parseMatchmakerQuery("+properties.maps:/.*(map3|some_map_foo).*/"),
        properties,
      ).matched,
    ).toBe(true);
  });
});

describe("M7 匹配池: 按会话批量撤票", () => {
  it("test_remove_all_for_a_session_clears_only_its_tickets", () => {
    const rig = new MatchmakerRig();
    rig.add({ sessionId: "a", query: "*", minCount: 2, maxCount: 2 });
    rig.add({ sessionId: "a", query: "*", minCount: 2, maxCount: 2 });
    rig.add({ sessionId: "b", query: "*", minCount: 2, maxCount: 2 });
    expect(rig.pool.removeSessionAll("a")).toHaveLength(2);
    expect(rig.tickets()).toHaveLength(1);
  });
});
