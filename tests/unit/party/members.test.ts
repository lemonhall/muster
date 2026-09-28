import { describe, expect, it } from "vitest";

import {
  decideAccept,
  decideJoin,
  decideJoinRequest,
  decideLeave,
  decidePromote,
  decideRemove,
  decideReserve,
  findSender,
  memberCountOf,
  oldestOf,
  sizeOf,
} from "../../../src/domain/party/members";
import type {
  PartyMemberEntry,
  PartyPresence,
  PartyRequestEntry,
} from "../../../src/domain/party/types";

/**
 * M8 派对规则层（纯函数）的逐条断言。
 *
 * 这一层对着上游 `server/party_presence.go` 与 `server/party_handler.go` 的
 * 校验顺序写：**顺序就是契约**，所以每条用例都把"同时违反多条规则"的情况摆进去，
 * 断言报出来的是最先检查的那一条。
 *
 * 溯源: server/party_handler_test.go::TestPartyMatchmakerAddAndRemove
 *
 * 契约源（机器可读）：
 * 契约源: server/party_presence.go::PartyPresenceList.Reserve
 * 契约源: server/party_handler.go::PartyHandler.JoinRequest
 *
 * REQ-0001-019
 */

const NODE = "node1";

function presence(userId: string, sessionId = `s-${userId}`): PartyPresence {
  return { userId, sessionId, username: `u-${userId}`, node: NODE };
}

function member(entry: PartyPresence, seq: number, reserved = false): PartyMemberEntry {
  return { presence: entry, reserved, seq };
}

function request(entry: PartyPresence, seq: number): PartyRequestEntry {
  return { presence: entry, seq };
}

describe("M8 成员表: 计数与最老者", () => {
  it("test_size_counts_reserved_seats", () => {
    const entries = [member(presence("a"), 1), member(presence("b"), 2, true)];
    expect(sizeOf(entries)).toBe(2);
    // 预留位不是成员：对外广播的 `presences` 里不该有它。
    expect(memberCountOf(entries)).toBe(1);
  });

  it("test_oldest_is_the_first_real_member", () => {
    const entries = [member(presence("reserved"), 1, true), member(presence("b"), 2)];
    expect(oldestOf(entries)?.presence.userId).toBe("b");
    expect(oldestOf([member(presence("r"), 1, true)])).toBeUndefined();
  });
});

describe("M8 成员表: Reserve / Join", () => {
  it("test_reserve_is_idempotent_and_respects_max_size", () => {
    expect(decideReserve([], 2, "s-a")).toEqual({ ok: true, alreadyReserved: false });
    const full = [member(presence("a"), 1), member(presence("b"), 2)];
    expect(decideReserve(full, 2, "s-c")).toEqual({ ok: false, kind: "full" });
    // 已经在预留表里的人：重复预留是幂等的成功。
    expect(decideReserve([member(presence("a"), 1, true)], 1, "s-a")).toEqual({
      ok: true,
      alreadyReserved: true,
    });
  });

  it("test_join_skips_known_sessions_and_reports_full_once", () => {
    const entries = [member(presence("a"), 1)];
    const decided = decideJoin(entries, 2, [presence("a"), presence("b")]);
    expect(decided.ok).toBe(true);
    if (decided.ok) expect(decided.added.map((one) => one.userId)).toEqual(["b"]);

    // 三个人同时进、上限 2：整批被拒，一个都不进（上游是"一次性判断容量"）。
    const tooMany = decideJoin(entries, 2, [presence("b"), presence("c")]);
    expect(tooMany).toEqual({ ok: false, kind: "full" });
  });
});

describe("M8 成员表: JoinRequest 的五条校验（顺序即契约）", () => {
  it("test_full_beats_everything_else", () => {
    const entries = [member(presence("a"), 1)];
    const requests = [request(presence("b"), 1)];
    const decided = decideJoinRequest(
      entries,
      requests,
      { maxSize: 1, open: true },
      presence("b"),
    );
    expect(decided).toEqual({ ok: false, kind: "full" });
  });

  it("test_open_parties_auto_join_before_request_checks", () => {
    const requests = [request(presence("b"), 1)];
    const decided = decideJoinRequest([], requests, { maxSize: 4, open: true }, presence("b"));
    expect(decided).toEqual({ ok: true, autoJoin: true });
  });

  it("test_request_table_full_uses_max_size", () => {
    const requests = [request(presence("b"), 1), request(presence("c"), 2)];
    const decided = decideJoinRequest([], requests, { maxSize: 2, open: false }, presence("d"));
    expect(decided).toEqual({ ok: false, kind: "join-requests-full" });
  });

  it("test_duplicate_request_is_rejected_by_user_id", () => {
    const requests = [request(presence("b"), 1)];
    const decided = decideJoinRequest([], requests, { maxSize: 4, open: false }, presence("b", "s-其他"));
    expect(decided).toEqual({ ok: false, kind: "join-request-duplicate" });
  });

  it("test_already_member_branch_looks_up_the_session_key_so_it_almost_never_fires", () => {
    // 上游查的是 `presenceMap[UserID]`，而那张表的键其实是 SessionID。
    // 于是只有当"某个成员的会话 id 恰好等于请求者的用户 id"时才命中。
    const hit = [
      member({ userId: "someone", sessionId: "x", username: "u-someone", node: NODE }, 1),
    ];
    expect(
      decideJoinRequest(hit, [], { maxSize: 4, open: false }, {
        userId: "x",
        sessionId: "s-x",
        username: "u-x",
        node: NODE,
      }),
    ).toEqual({ ok: false, kind: "join-request-already-member" });

    // 正常的会话 id 与用户 id 不同：这条校验不触发，于是又产生一条请求
    // （已经是成员的人对私有派对再发一次 `party_join` 会排队）。
    const normal = [member(presence("x"), 1)];
    expect(decideJoinRequest(normal, [], { maxSize: 4, open: false }, presence("x"))).toEqual({
      ok: true,
      autoJoin: false,
    });
  });
});

describe("M8 成员表: Leave / Accept / Promote / Remove / DataSend", () => {
  it("test_leave_only_reports_people_actually_in_the_table", () => {
    const entries = [member(presence("a"), 1), member(presence("b"), 2)];
    expect(decideLeave(entries, ["s-a", "s-缺", "s-a"]).map((one) => one.userId)).toEqual(["a"]);
  });

  it("test_accept_requires_full_presence_triple", () => {
    const requests = [request(presence("b"), 1)];
    expect(decideAccept([], requests, 4, presence("b")).ok).toBe(true);
    const wrongName = { ...presence("b"), username: "换了个名字" };
    expect(decideAccept([], requests, 4, wrongName)).toEqual({ ok: false, kind: "not-request" });
    expect(decideAccept([], requests, 0, presence("b"))).toEqual({ ok: false, kind: "full" });
  });

  it("test_promote_requires_a_member_with_the_same_triple", () => {
    const entries = [member(presence("a"), 1)];
    expect(decidePromote(entries, presence("a")).ok).toBe(true);
    expect(decidePromote(entries, presence("b"))).toEqual({ ok: false, kind: "not-member" });
  });

  it("test_remove_falls_back_to_the_request_table", () => {
    const entries = [member(presence("a"), 1)];
    const requests = [request(presence("b"), 1)];
    expect(decideRemove(entries, requests, presence("a"))).toEqual({ ok: true, outcome: "member" });
    expect(decideRemove(entries, requests, presence("b"))).toEqual({ ok: true, outcome: "request" });
    expect(decideRemove(entries, requests, presence("c"))).toEqual({ ok: false, kind: "not-member" });
  });

  it("test_data_send_sender_is_matched_by_session_and_node", () => {
    const entries = [member(presence("a"), 1)];
    expect(findSender(entries, "s-a", NODE)?.presence.userId).toBe("a");
    expect(findSender(entries, "s-a", "别的节点")).toBeUndefined();
  });
});
