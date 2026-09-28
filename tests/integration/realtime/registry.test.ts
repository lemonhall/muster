import { describe, expect, it } from "vitest";

import {
  CALLER_ID,
  CALLER_USERNAME,
  PEER_ID,
  PEER_USERNAME,
  insertUser,
} from "../../helpers/realtime";
import {
  eventKeys,
  expectNoFrame,
  openSocket,
  registryPost,
  waitForFrame,
  type TestSocket,
} from "../../helpers/realtime-socket";
import { createTenant } from "../../helpers/tenants";

/**
 * M3 契约测试：会话注册表 DO + 分片 DO 的在线状态，**走真实 WebSocket**。
 *
 * 与 `pipeline-status.test.ts` 的分工是刻意的：那边把注册表换成假的，断言的是管线
 * "说了什么"；这里两端都是真的，断言的是"事件真的到达了对的人手上几次"。
 *
 * **每个用例用一个全新的租户 id**：会话注册表按租户分实例、分片按 `租户|会话` 命名，
 * 所以随机租户名天然给出干净状态（DO 的 SQLite 在同一个测试文件里是共享的，
 * 不换租户就会读到上一个用例留下的会话）。顺带地，这也让"多租户不串号"成为被真实验证的断言。
 *
 * 被钉住的四条上游语义（`server/socket_ws.go` + `server/tracker.go` +
 * `server/status_registry.go`）：
 *
 * 1. 握手时会话**无条件关注自己**（`statusRegistry.Follow(sessionID, {userID})` 排在
 *    `tracker.TrackMulti` 之前），所以 `status=true` 的连接会先收到一条关于自己的 join；
 * 2. presence 是**每会话**的：同一用户两条连接就是两条 presence；
 * 3. 事件只发给**关注了该用户**的会话，且上线一条、下线一条，不丢不重；
 * 4. 取消关注之后不再收到该用户的事件。
 *
 * 契约源（机器可读）：
 * 契约源: server/socket_ws.go::NewSocketWsAcceptor
 * 契约源: server/tracker.go::LocalTracker.TrackMulti
 * 契约源: server/tracker.go::LocalTracker.Untrack
 * 契约源: server/status_registry.go::LocalStatusRegistry.Follow
 * 契约源: server/status_registry.go::LocalStatusRegistry.Queue
 *
 * REQ-0001-009
 */

interface Fixture {
  readonly tenant: string;
  readonly opened: TestSocket[];
  open(session: string, userId: string, username: string, wantsStatus?: boolean): Promise<TestSocket>;
}

async function fixture(): Promise<Fixture> {
  const tenant = crypto.randomUUID().toUpperCase();
  await createTenant(tenant, `server-key-${tenant}`, "realtime");
  await insertUser(tenant, CALLER_ID, CALLER_USERNAME);
  await insertUser(tenant, PEER_ID, PEER_USERNAME);

  const opened: TestSocket[] = [];
  return {
    tenant,
    opened,
    async open(session, userId, username, wantsStatus = true) {
      const target = await openSocket(tenant, session, userId, username, { wantsStatus });
      opened.push(target);
      return target;
    },
  };
}

/** 每个用例用独立会话名，读日志时一眼能看出是哪条用例的。 */
function sessionId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

describe("M3 契约: 在线状态（真实 DO + 真实 WebSocket）", () => {
  it("test_a_status_enabled_session_is_told_about_its_own_presence", async () => {
    const world = await fixture();
    const session = sessionId("self");

    const caller = await world.open(session, CALLER_ID, CALLER_USERNAME);

    const join = await waitForFrame(caller, (envelope) => envelope.message.case === "statusPresenceEvent");
    expect(eventKeys(join)).toEqual({ joins: [`${CALLER_ID}/${session}/`], leaves: [] });
  });

  it("test_a_session_without_the_status_flag_has_no_presence", async () => {
    const world = await fixture();
    const quiet = await world.open(sessionId("quiet"), CALLER_ID, CALLER_USERNAME, false);
    const watcher = sessionId("watcher");
    await world.open(watcher, PEER_ID, PEER_USERNAME);

    const result = await registryPost<{ presences: unknown[] }>(world.tenant, "/follow", {
      sessionId: watcher,
      userIds: [CALLER_ID],
    });

    expect(result.presences).toEqual([]);
    await expectNoFrame(
      quiet,
      (envelope) => envelope.message.case === "statusPresenceEvent",
      50,
    );
  });

  it("test_two_sessions_of_the_same_user_produce_two_presences", async () => {
    const world = await fixture();
    const first = sessionId("peer-a");
    const second = sessionId("peer-b");
    await world.open(first, PEER_ID, PEER_USERNAME);
    await world.open(second, PEER_ID, PEER_USERNAME);
    const caller = sessionId("caller");
    await world.open(caller, CALLER_ID, CALLER_USERNAME);

    const result = await registryPost<{ presences: { sessionId: string }[] }>(
      world.tenant,
      "/follow",
      { sessionId: caller, userIds: [PEER_ID] },
    );

    // presence 是每会话的：同一个人两条连接就是两条快照，各自带自己的 session_id。
    expect(result.presences.map((presence) => presence.sessionId).sort()).toEqual(
      [first, second].sort(),
    );
  });

  it("test_a_follower_learns_about_the_followed_user_joining_and_leaving_exactly_once", async () => {
    const world = await fixture();
    const callerSession = sessionId("follower");
    const peerSession = sessionId("followed");
    const caller = await world.open(callerSession, CALLER_ID, CALLER_USERNAME);
    // 先订阅：此刻对方还没上线，快照就该是空的。
    const before = await registryPost<{ presences: unknown[] }>(world.tenant, "/follow", {
      sessionId: callerSession,
      userIds: [PEER_ID],
    });
    expect(before.presences).toEqual([]);

    // 对方上线 → 关注者收到一条 join。
    await world.open(peerSession, PEER_ID, PEER_USERNAME);
    const join = await waitForFrame(
      caller,
      (envelope) =>
        envelope.message.case === "statusPresenceEvent" &&
        eventKeys(envelope).joins.includes(`${PEER_ID}/${peerSession}/`),
    );
    expect(eventKeys(join)).toEqual({ joins: [`${PEER_ID}/${peerSession}/`], leaves: [] });

    // 对方下线 → 关注者收到一条 leave，且只有这一条。
    await registryPost(world.tenant, "/disconnect", { sessionId: peerSession });
    const leave = await waitForFrame(
      caller,
      (envelope) =>
        envelope.message.case === "statusPresenceEvent" &&
        eventKeys(envelope).leaves.includes(`${PEER_ID}/${peerSession}/`),
    );
    expect(eventKeys(leave)).toEqual({ joins: [], leaves: [`${PEER_ID}/${peerSession}/`] });
  });

  it("test_unfollowing_stops_the_events", async () => {
    const world = await fixture();
    const callerSession = sessionId("unfollow");
    const caller = await world.open(callerSession, CALLER_ID, CALLER_USERNAME);
    await registryPost(world.tenant, "/follow", { sessionId: callerSession, userIds: [PEER_ID] });
    await registryPost(world.tenant, "/unfollow", { sessionId: callerSession, userIds: [PEER_ID] });

    const peerSession = sessionId("after-unfollow");
    await world.open(peerSession, PEER_ID, PEER_USERNAME);

    await expectNoFrame(
      caller,
      (envelope) =>
        envelope.message.case === "statusPresenceEvent" &&
        eventKeys(envelope).joins.includes(`${PEER_ID}/${peerSession}/`),
    );
  });

  it("test_a_published_status_replaces_the_presence_and_notifies_followers", async () => {
    const world = await fixture();
    const callerSession = sessionId("watcher");
    const peerSession = sessionId("publisher");
    const caller = await world.open(callerSession, CALLER_ID, CALLER_USERNAME);
    await registryPost(world.tenant, "/follow", { sessionId: callerSession, userIds: [PEER_ID] });
    await world.open(peerSession, PEER_ID, PEER_USERNAME);
    await waitForFrame(
      caller,
      (envelope) =>
        envelope.message.case === "statusPresenceEvent" &&
        eventKeys(envelope).joins.includes(`${PEER_ID}/${peerSession}/`),
    );

    await registryPost(world.tenant, "/status", {
      sessionId: peerSession,
      userId: PEER_ID,
      username: PEER_USERNAME,
      wantsStatus: true,
      status: "in game",
    });

    // 上游 `tracker.Update` 同时产生 joins（新）与 leaves（旧）：状态改了就是
    // "旧的我走了、新的我来了"，两条一起发。
    const update = await waitForFrame(
      caller,
      (envelope) =>
        envelope.message.case === "statusPresenceEvent" &&
        eventKeys(envelope).joins.includes(`${PEER_ID}/${peerSession}/in game`),
    );
    expect(eventKeys(update)).toEqual({
      joins: [`${PEER_ID}/${peerSession}/in game`],
      leaves: [`${PEER_ID}/${peerSession}/`],
    });

    const snapshot = await registryPost<{
      presences: { userId: string; sessionId: string; username: string; status: string }[];
    }>(world.tenant, "/follow", { sessionId: callerSession, userIds: [PEER_ID] });
    expect(snapshot.presences).toContainEqual({
      userId: PEER_ID,
      sessionId: peerSession,
      username: PEER_USERNAME,
      status: "in game",
    });
  });

  it("test_another_tenant_cannot_see_or_notify_this_tenants_sessions", async () => {
    const world = await fixture();
    const other = crypto.randomUUID().toUpperCase();
    await createTenant(other, `server-key-${other}`, "realtime-other");
    await insertUser(other, PEER_ID, PEER_USERNAME);

    const callerSession = sessionId("tenant-a-watcher");
    const caller = await world.open(callerSession, CALLER_ID, CALLER_USERNAME);
    await registryPost(world.tenant, "/follow", { sessionId: callerSession, userIds: [PEER_ID] });

    // 另一个租户里"同一个 user id"上线：本租户既不该看到 presence，也不该收到事件。
    await openSocket(other, sessionId("tenant-b-peer"), PEER_ID, PEER_USERNAME, {});
    const snapshot = await registryPost<{ presences: unknown[] }>(world.tenant, "/follow", {
      sessionId: callerSession,
      userIds: [PEER_ID],
    });
    expect(snapshot.presences).toEqual([]);
    // 注意排除掉"自己上线"那条（握手时的自我关注一定会发，见本文件头注释）。
    await expectNoFrame(
      caller,
      (envelope) =>
        envelope.message.case === "statusPresenceEvent" &&
        eventKeys(envelope).joins.some((key) => key.startsWith(`${PEER_ID}/`)),
    );
  });
});
