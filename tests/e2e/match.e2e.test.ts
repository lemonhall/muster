import { afterEach, describe, expect, it } from "vitest";

import { call } from "./http-helpers";
import {
  ROUND_TRIP_MS,
  claimsOf,
  closeSockets,
  freshRun,
  liveDataOf,
  matchReply,
  matched,
  player,
  presenceEvent,
  ticketText,
} from "./match-helpers";
import { matchCreate, matchDataSend, matchJoin, matchLeave, matchmakerAdd } from "./ws-helpers";

/**
 * M7 E2E：匹配与对局，走真实 `wrangler dev --local` 进程上的真 WebSocket + 真 HTTP。
 *
 * 与 `tests/integration/match/` 的分工：那边直接拿 DO stub，验的是对局语义（谁在场、
 * 谁收得到、成局挑的是谁）；这里两端都是网络上的真连接，验的是**整条链在真实进程里成立**——
 * 匹配器的闹钟、成局帧投递到会话分片、`match_join` 走 token 时"新建一场中继对局"、
 * 中继广播不回显发送者、离开时另一侧收到 `match_presence_event`，以及对局目录的 REST 面。
 *
 * 目标进程是本机 workerd（见 `global-setup.ts`），不连任何 Cloudflare 账号资源。
 *
 * 时间预算：本地 dev 每个往返约 1.4s（M2 Review 记的），成局还要等匹配器的闹钟，
 * 所以单条用例按分钟给预算。
 *
 * 契约源（机器可读）：
 * 契约源: server/matchmaker.go::LocalMatchmaker.Add
 * 契约源: server/pipeline_match.go::Pipeline.matchJoin
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/match
 *
 * REQ-0001-017
 * REQ-0001-018
 */

afterEach(closeSockets);

describe("M7 E2E: 匹配与对局", () => {
  it("test_two_clients_match_join_by_token_exchange_data_then_one_leaves", { timeout: 240_000 }, async () => {
    const alice = await player();
    const bob = await player();
    const { query, strings } = freshRun();
    const request = { minCount: 2, maxCount: 2, query, strings };

    alice.socket.send(matchmakerAdd("add-alice", request));
    const aliceTicket = await ticketText(alice.socket, "add-alice");
    bob.socket.send(matchmakerAdd("add-bob", request));
    const bobTicket = await ticketText(bob.socket, "add-bob");
    // 票号逐张不同：`matchmaker_ticket` 不是"这一组的 id"。
    expect(aliceTicket).not.toBe("");
    expect(bobTicket).not.toBe("");
    expect(aliceTicket).not.toBe(bobTicket);

    const aliceMatched = await matched(alice.socket);
    const bobMatched = await matched(bob.socket);
    // 同一组拿到同一个令牌；`users` 含收件人自己（两条各自的顺序可以不同，比集合）。
    expect(aliceMatched.token).toBe(bobMatched.token);
    expect(aliceMatched.mid).toBe(bobMatched.mid);
    expect([...aliceMatched.users].sort()).toEqual(
      [`${alice.userId}/${alice.username}`, `${bob.userId}/${bob.username}`].sort(),
    );
    expect([...bobMatched.users].sort()).toEqual([...aliceMatched.users].sort());
    // `self` 是"这一份帧发给谁"，两份各不相同。
    expect(aliceMatched.selfUserId).toBe(alice.userId);
    expect(bobMatched.selfUserId).toBe(bob.userId);
    // token 里的 mid 是 `<新 uuid>.`：node 段**空**，代表"去开一场中继对局"。
    expect(aliceMatched.mid).toMatch(/^[0-9a-f-]{36}\.$/u);
    const nowSec = Math.floor(Date.now() / 1000);
    const ttl = claimsOf(aliceMatched.token).exp - nowSec;
    expect(ttl).toBeGreaterThan(20);
    expect(ttl).toBeLessThanOrEqual(31);

    // 两个人各自拿同一个 token 去 join：第一个人的 join **创建**这场中继对局。
    alice.socket.send(matchJoin("join-alice", { token: aliceMatched.token }));
    const aliceJoin = await matchReply(alice.socket, "join-alice");
    bob.socket.send(matchJoin("join-bob", { token: aliceMatched.token }));
    const bobJoin = await matchReply(bob.socket, "join-bob");

    for (const [name, reply] of [["alice", aliceJoin], ["bob", bobJoin]] as const) {
      expect(reply.matchId, name).toBe(aliceMatched.mid);
      expect(reply.authoritative, name).toBe(false);
      // 中继对局的 join 回执**不带** label 字段（权威对局才带，哪怕是空串）。
      expect(reply.label, name).toBeUndefined();
      expect(reply.self, name).toBe(
        name === "alice" ? `${alice.userId}/${alice.username}` : `${bob.userId}/${bob.username}`,
      );
    }
    // 先来的人看不到任何人，后来的人看到"已经在里面的人"（不含自己）。
    expect(aliceJoin.presences).toHaveLength(0);
    expect(bobJoin.presences).toEqual([`${alice.userId}/${alice.username}`]);
    // 后进来这件事会广播给已在场的人。
    const joined = await presenceEvent(alice.socket, (event) => event.joins.length === 1);
    expect(joined.matchId).toBe(aliceMatched.mid);
    expect(joined.joins).toEqual([`${bob.userId}/${bob.username}`]);
    expect(joined.leaves).toEqual([]);

    // 中继数据：发送者**收不到**自己的帧（只有把自己写进过滤器才会回显）。
    alice.socket.send(matchDataSend("data-1", aliceMatched.mid, 7n, '{"hp":100}'));
    const dataFrame = await bob.socket.waitForFrame(
      (candidate) => candidate.message.case === "matchData",
      ROUND_TRIP_MS,
    );
    const data = liveDataOf(dataFrame);
    expect(data).toEqual({
      matchId: aliceMatched.mid,
      opCode: 7n,
      text: '{"hp":100}',
      from: `${alice.userId}/${alice.username}`,
      reliable: true,
    });
    expect(alice.socket.frames.some((frame) => frame.message.case === "matchData")).toBe(false);

    // 一方离开：自己收到只带 cid 的空信封，另一侧收到 leaves。
    bob.socket.send(matchLeave("leave-bob", aliceMatched.mid));
    const ack = await bob.socket.waitForFrame(
      (candidate) => candidate.cid === "leave-bob",
      ROUND_TRIP_MS,
    );
    expect(ack.message.case).toBeUndefined();
    const left = await presenceEvent(alice.socket, (event) => event.leaves.length === 1);
    // 事件里的 match id 是**规范形**；中继对局的 node 段是空串，所以形状与 join 时一致。
    expect(left.matchId).toBe(aliceMatched.mid);
    expect(left.joins).toEqual([]);
    expect(left.leaves).toEqual([`${bob.userId}/${bob.username}`]);
  });

  it("test_the_registry_lists_a_created_match_and_bad_limits_return_a_status_body", { timeout: 120_000 }, async () => {
    const alice = await player();
    // 带名字的 `match_create`：id 由名字派生（同名同局），创作者自己就在里面。
    const name = `e2e-match-${crypto.randomUUID()}`;
    alice.socket.send(matchCreate("create-1", name));
    const created = await matchReply(alice.socket, "create-1");
    expect(created.matchId).toMatch(/^[0-9a-f-]{36}\.$/u);
    expect(created.authoritative).toBe(false);
    // 给了名字时 `size` 是含自己的成员数。
    expect(created.self).toBe(`${alice.userId}/${alice.username}`);

    const listed = await call("/v2/match?limit=100", { token: alice.token });
    expect(listed.status, `列出对局失败：${listed.status} ${await listed.clone().text()}`).toBe(200);
    const body = (await listed.json()) as {
      readonly matches?: readonly {
        readonly match_id: string;
        readonly authoritative: boolean;
        readonly size: number;
      }[];
    };
    const entry = (body.matches ?? []).find((match) => match.match_id === created.matchId);
    expect(entry, `刚建的对局不在目录里：${JSON.stringify(body.matches)}`).toBeDefined();
    expect(entry?.size).toBe(1);
    // 中继对局的 `authoritative: false` 是零值，protojson 会省略这个键。
    expect(entry?.authoritative ?? false).toBe(false);

    const stats = await call("/v2/matchmaker/stats", { token: alice.token });
    expect(stats.status).toBe(200);
    const statsBody = (await stats.json()) as Record<string, unknown>;
    // 空池的 `ticket_count: 0` 是零值，会连键一起省略；所以这里只钉"形状是那三个字段"。
    for (const key of Object.keys(statsBody)) {
      expect(["ticket_count", "oldest_ticket_create_time", "completions"], key).toContain(key);
    }
    if (statsBody["ticket_count"] !== undefined) {
      expect(typeof statsBody["ticket_count"]).toBe("number");
    }

    // 错误体必须是上游 `google.rpc.Status` 的形状（`{code, message}`），不是随便一段文本。
    const badLimit = await call("/v2/match?limit=0", { token: alice.token });
    expect(badLimit.status).toBe(400);
    expect(await badLimit.json()).toEqual({
      code: 3,
      message: "Invalid limit - limit must be between 1 and 100.",
    });
  });
});
