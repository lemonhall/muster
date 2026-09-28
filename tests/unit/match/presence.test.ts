import { describe, expect, it } from "vitest";

import { MatchPresenceList, type MatchPresence } from "../../../src/domain/match/presence";

/**
 * M7：对局成员表（上游 `MatchPresenceList`）。
 *
 * 上游是一条 `map[sessionID]*Presence`：`Join` 覆盖、`Leave` 删除、`ListPresences` 给快照。
 * 三个动作都可观测——`match_join` 回执里的 `size` 是 `Size()`、`presences` 是
 * `ListPresences()` 的"去掉刚加入的那个人"、离开之后 `size` 必须跟着掉。
 *
 * 唯一刻意的差异：上游是 Go map（顺序随机），这里用 `Map` 保**插入序**，
 * 于是"同一批操作得到同一份快照"总是成立（ECN-0011 偏差 5）。
 *
 * 溯源: server/match_presence_test.go::TestMatchPresenceList
 *
 * 契约源（机器可读）：
 * 契约源: server/match_presence.go::MatchPresenceList.Join
 * 契约源: server/match_presence.go::MatchPresenceList.Leave
 *
 * REQ-0001-018
 */

function presence(sessionId: string): MatchPresence {
  return { node: "muster", userId: `u-${sessionId}`, sessionId, username: sessionId };
}

describe("M7 对局成员表", () => {
  it("test_join_then_list_is_a_snapshot", () => {
    const list = new MatchPresenceList();
    expect(list.size()).toBe(0);

    list.join([presence("s1"), presence("s2")]);
    expect(list.size()).toBe(2);
    expect(list.list().map((item) => item.sessionId)).toEqual(["s1", "s2"]);
    // 快照是拷贝：改动返回值不该影响表。
    const snapshot = list.list() as MatchPresence[];
    snapshot.push(presence("s3"));
    expect(list.size()).toBe(2);
  });

  it("test_joining_the_same_session_covers_instead_of_duplicating", () => {
    const list = new MatchPresenceList();
    list.join([presence("s1")]);
    list.join([{ ...presence("s1"), username: "renamed" }]);

    expect(list.size()).toBe(1);
    expect(list.list()[0]?.username).toBe("renamed");
  });

  it("test_leave_removes_and_size_follows", () => {
    const list = new MatchPresenceList();
    list.join([presence("s1"), presence("s2"), presence("s3")]);
    list.leave([presence("s2")]);

    expect(list.size()).toBe(2);
    expect(list.has("s2")).toBe(false);
    // 离开一个本来就不在的人：不是错误，也不改任何东西。
    list.leave([presence("s9")]);
    expect(list.size()).toBe(2);
  });

  it("test_list_for_joiner_excludes_the_newcomer", () => {
    const list = new MatchPresenceList();
    list.join([presence("s1"), presence("s2")]);
    // 上游 `JoinAttempt` 回给"刚加入的人"的快照里没有他自己。
    expect(list.listForJoiner("s2").map((item) => item.sessionId)).toEqual(["s1"]);
    // 老成员重复 join 时他会出现在快照里（因为他不是"刚加入"的那个）。
    expect(list.listForJoiner("s3").map((item) => item.sessionId)).toEqual(["s1", "s2"]);
  });

  it("test_list_except_is_the_broadcast_view", () => {
    const list = new MatchPresenceList();
    list.join([presence("s1"), presence("s2")]);
    expect(list.listExcept("s1").map((item) => item.sessionId)).toEqual(["s2"]);
  });

  it("test_leave_session_by_id", () => {
    const list = new MatchPresenceList();
    list.join([presence("s1")]);
    list.leaveSession("s1");
    expect(list.has("s1")).toBe(false);
  });
});
