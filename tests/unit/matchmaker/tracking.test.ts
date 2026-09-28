import { describe, expect, it } from "vitest";

import { MatchmakerError } from "../../../src/domain/matchmaker/errors";
import { MatchmakerRig } from "../../helpers/matchmaker-world";

/**
 * M7 契约：**每派对**的票数上限，以及成局之后名额怎么回落。
 *
 * 上游 `TestMatchmakerMaxPartyTracking` 直接对着 `LocalMatchmaker` 调 `Add`：一个
 * 派对占满 `max_tickets`（默认 3）张票之后，第四张必须报 `too many tickets`；换个
 * 派对照样能加，而且能和前面的票成局；成局消耗掉的票会腾出名额。
 *
 * 派对票只由派对处理器发起（`party_matchmaker_add`，M8），所以这一条留在池子层测：
 * 走 socket 的 `matchmaker_add` 永远带 `partyId = ""`，够不着这条分支。
 *
 * 溯源: server/matchmaker_test.go::TestMatchmakerMaxPartyTracking
 *
 * 契约源（机器可读）：
 * 契约源: server/matchmaker.go::LocalMatchmaker.Add
 *
 * REQ-0001-017
 */

const PARTY_TICKET = {
  query: "properties.a5:bar",
  minCount: 2,
  maxCount: 2,
  strings: { a5: "bar" },
} as const;

describe("M7 契约: 每派对的票数上限", () => {
  it("test_a_party_may_hold_three_tickets_and_a_match_frees_a_slot", () => {
    const rig = new MatchmakerRig();
    const addParty = (partyId: string, member: string) =>
      rig.add({ sessionId: "", partyId, members: [member], ...PARTY_TICKET });

    for (let index = 0; index < 3; index += 1) {
      expect(addParty("party-a", "a").ticket).not.toBe("");
    }
    expect(() => addParty("party-a", "a")).toThrowError(MatchmakerError);

    // 另一个派对不受影响，而且能和 party-a 的票配上——同一派对之间才是互斥的。
    expect(addParty("party-b", "b").ticket).not.toBe("");
    expect(rig.process()).toEqual([["a", "b"]]);

    // 被消耗的那张腾出了名额：party-a 又能加一张，再加第二张时才撞上限。
    expect(addParty("party-a", "a").ticket).not.toBe("");
    expect(() => addParty("party-a", "a")).toThrowError(MatchmakerError);
  });
});
