import { afterAll, describe, expect, it } from "vitest";

import {
  ask,
  closeAllMatchWorlds,
  matchJoinEnvelope,
  matchPost,
  matchWorld,
  matchmakerAddEnvelope,
} from "../../helpers/match-world";
import { waitForFrame, type TestSocket } from "../../helpers/realtime-socket";

/**
 * M7 契约：成局之后"给 match id 还是给 token"，以及票数上限的记功与释放。
 *
 * 上游这两条用例都建在 `createTestMatchmaker(..., tickerActive=true, callback)` 上：
 * 一条注册"人数对得上且都带 `mode=authoritative` 就开权威对局"的回调，一条盯着
 * 每会话/每派对的票数上限。本项目把回调换成 DO 上的**声明式钩子**（`/hook`），
 * 断言的东西一模一样：收到的帧里是 `match_id` 还是 `token`、成局后票数有没有回落。
 *
 * 溯源: server/matchmaker_test.go::TestMatchmakerAddAndMatchAuthoritative
 * 溯源: server/matchmaker_test.go::TestMatchmakerMaxSessionTracking
 *
 * 契约源（机器可读）：
 * 契约源: server/matchmaker.go::LocalMatchmaker.Process
 * 契约源: server/matchmaker.go::LocalMatchmaker.Add
 *
 * REQ-0001-017
 */

afterAll(closeAllMatchWorlds);

/** 等一条成局帧。它与任何 cid 都不对应（服务端主动推的），所以不能用 `ask`。 */
function waitForMatched(socket: TestSocket) {
  return waitForFrame(socket, (frame) => frame.message.case === "matchmakerMatched");
}

describe("M7 契约: 成局目标由钩子决定", () => {
  it("test_an_authoritative_hook_turns_the_group_into_a_real_match_id", async () => {
    const world = await matchWorld();
    await world.setHook({ size: 2, match: { mode: "authoritative" } });

    const first = await world.open(crypto.randomUUID(), crypto.randomUUID(), "one");
    const second = await world.open(crypto.randomUUID(), crypto.randomUUID(), "two");
    const input = {
      minCount: 2,
      maxCount: 2,
      query: "properties.d1:foo",
      strings: { d1: "foo", mode: "authoritative" },
    };
    await ask(first, matchmakerAddEnvelope("c1", input));
    await ask(second, matchmakerAddEnvelope("c2", input));

    const round = await world.process();
    expect(round.matches).toBe(1);
    expect(round.tickets).toHaveLength(2);

    const one = await waitForMatched(first);
    const two = await waitForMatched(second);
    if (one.message.case !== "matchmakerMatched" || two.message.case !== "matchmakerMatched") {
      throw new Error("unreachable");
    }
    const value = one.message.value;
    // 权威分支给的是 match id（`<uuid>.<node>`），**不是** token。
    expect(value.id.case).toBe("matchId");
    const matchId = value.id.case === "matchId" ? value.id.value : "";
    expect(matchId.endsWith(".muster")).toBe(true);
    // `users` 含收件人自己，`self` 是"这份帧发给谁"。
    expect(value.users).toHaveLength(2);
    expect(value.self?.presence?.sessionId).toBe(first.sessionId);
    expect(two.message.value.self?.presence?.sessionId).toBe(second.sessionId);
    expect(two.message.value.id.case === "matchId" ? two.message.value.id.value : "").toBe(matchId);

    // 权威对局在成局之前就建好了：拿着这个 id 直接 join 就能进（DoD 8 的那条链）。
    const reply = await ask(first, matchJoinEnvelope("c3", { matchId }));
    expect(reply.message.case).toBe("match");
  });

  it("test_without_a_hook_the_group_gets_a_thirty_second_token", async () => {
    const world = await matchWorld();
    const socket = await world.open(crypto.randomUUID(), crypto.randomUUID(), "lonely");
    // 两张同 query 的票换个会话发，凑成一组。
    const peer = await world.open(crypto.randomUUID(), crypto.randomUUID(), "peer");
    const input = { minCount: 2, maxCount: 2, query: "*" };
    await ask(socket, matchmakerAddEnvelope("c1", input));
    await ask(peer, matchmakerAddEnvelope("c2", input));
    await world.process();

    const frame = await waitForMatched(socket);
    if (frame.message.case !== "matchmakerMatched") throw new Error("unreachable");
    expect(frame.message.value.id.case).toBe("token");
    // token 里的 mid 是 `<新 uuid>.`：node 段**空**，代表"去开一场中继对局"。
    const token = frame.message.value.id.case === "token" ? frame.message.value.id.value : "";
    expect(token.split(".")).toHaveLength(3);
  });
});

describe("M7 契约: 每会话的票数上限", () => {
  it("test_a_session_may_hold_three_tickets_and_a_match_frees_a_slot", async () => {
    const world = await matchWorld();
    const one = crypto.randomUUID();
    const two = crypto.randomUUID();
    const matchmaker = world.matchmaker();
    // 直接用池子的 `/add`（上游这条用例也是直接调 `matchMaker.Add`）。
    // 为什么不走 socket：撞上限时上游会**关掉这条会话**（`return false` → `Close`），
    // 而关连接会顺手 `RemoveSessionAll` 把它名下的票全撤了——那样就再也测不到
    // "被消耗的票腾出名额"这件事了。
    const add = (sessionId: string) =>
      matchPost(matchmaker, "/add", {
        sessionId,
        userId: sessionId,
        username: sessionId,
        query: "properties.a5:bar",
        minCount: 2,
        maxCount: 2,
        countMultiple: 1,
        stringProperties: { a5: "bar" },
        numericProperties: {},
      });

    for (let index = 0; index < 3; index += 1) {
      expect(await add(one)).toMatchObject({ ok: true });
    }
    expect(await add(one)).toMatchObject({ ok: false, failure: "too-many-tickets" });

    // 另一个会话不受影响，而且能和上面的票配上（同会话的票**不能**互配）。
    expect(await add(two)).toMatchObject({ ok: true });
    const round = await world.process();
    expect(round.matches).toBe(1);
    expect(round.tickets).toHaveLength(2);

    // 被消耗的票腾出了名额：又能加回来一张，再加第二张时才撞上限。
    expect(await add(one)).toMatchObject({ ok: true });
    expect(await add(one)).toMatchObject({ ok: false, failure: "too-many-tickets" });
  });
});
