import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { SESSION_EVICT_AFTER_MS } from "../../../src/durable/session-registry";
import { SESSION_TOUCH_INTERVAL_MS } from "../../../src/durable/session-shard";
import type { SocketMeta } from "../../../src/realtime/socket-meta";
import {
  CALLER_ID,
  CALLER_USERNAME,
  PEER_ID,
  PEER_USERNAME,
  insertUser,
  pingEnvelope,
} from "../../helpers/realtime";
import {
  delay,
  eventKeys,
  openSocket,
  registryPost,
  waitForFrame,
  type TestSocket,
} from "../../helpers/realtime-socket";
import { createTenant } from "../../helpers/tenants";

/** 读闹钟时间：`stub.getAlarm()` 不在 DO 的 RPC 面上，得进实例里问 storage。 */
async function alarmOf(stub: DurableObjectStub): Promise<number | null> {
  return await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

/**
 * M3 契约测试：一条连接的**生命周期**——心跳、休眠唤醒、以及兜底清理。
 *
 * 这一组覆盖的是上游用"WS 控制帧 ping/读超时"完成、而 Worke​rs 上必须换一种做法的部分
 * （完整论证见 [ECN-0006](../../../docs/ecn/ECN-0006-realtime-on-durable-objects.md)）：
 *
 * 1. 连接活着 → 分片 DO 定期 `/touch` 注册表（心跳），注册表据此维持"在线"；
 * 2. 连接断开 → 分片立刻上报，并把心跳闹钟撤掉（不留空转的唤醒）；
 * 3. 连接元数据挂在 socket 上（而不是分片的内存里）——这正是 Hibernation API 能工作的前提；
 * 4. 兜底：某个会话长时间没再上报（分片自己没了），注册表的巡检把它清掉并给关注者补 leave。
 *
 * **没能测到的部分**：本机测试池（vitest-pool-workers 0.22.0）跑不了"优雅驱逐后恢复"
 * ——`evictDurableObject()` 会一直挂着不返回，`abortAllDurableObjects()` 则是把连接一起
 * 杀掉。所以休眠-唤醒只覆盖到"元数据在 socket 上"这条我们自己的责任，平台那一半留给
 * 线上验收；这条已登记在 [ECN-0006](../../../docs/ecn/ECN-0006-realtime-on-durable-objects.md) 与 M3 Review 的残余风险里。
 *
 * 契约源（机器可读）：
 * 契约源: server/session_ws.go::sessionWS.maybeResetPingTimer
 * 契约源: server/session_ws.go::sessionWS.pingNow
 *
 * REQ-0001-009
 */

interface World {
  readonly tenant: string;
  readonly shard: (sessionId: string) => DurableObjectStub;
  readonly registry: DurableObjectStub;
}

async function world(): Promise<World> {
  const tenant = crypto.randomUUID().toUpperCase();
  await createTenant(tenant, `server-key-${tenant}`, "lifecycle");
  await insertUser(tenant, CALLER_ID, CALLER_USERNAME);
  await insertUser(tenant, PEER_ID, PEER_USERNAME);
  return {
    tenant,
    shard: (sessionId) =>
      env.SESSION_SHARD.get(env.SESSION_SHARD.idFromName(`${tenant}|${sessionId}`)),
    registry: env.SESSION_REGISTRY.get(env.SESSION_REGISTRY.idFromName(tenant)),
  };
}

function sessionId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function open(
  world: World,
  session: string,
  userId: string,
  username: string,
): Promise<TestSocket> {
  return await openSocket(world.tenant, session, userId, username, { wantsStatus: true });
}

/** 有界轮询：等一个条件成立，失败时给出最后一次观察值。 */
async function waitUntil(
  probe: () => Promise<boolean>,
  timeoutMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await delay(20);
  }
  return false;
}

describe("M3 契约: 会话生命周期", () => {
  it("test_an_open_session_keeps_a_heartbeat_alarm_scheduled", async () => {
    const w = await world();
    const session = sessionId("alive");

    await open(w, session, CALLER_ID, CALLER_USERNAME);

    const alarm = await alarmOf(w.shard(session));
    expect(alarm).not.toBeNull();
    // 周期应当就是心跳周期（允许调度开销造成的少量漂移）。
    expect(alarm! - Date.now()).toBeLessThanOrEqual(SESSION_TOUCH_INTERVAL_MS);
  });

  it("test_the_heartbeat_touches_the_registry_and_schedules_the_next_one", async () => {
    const w = await world();
    const session = sessionId("beat");
    await open(w, session, CALLER_ID, CALLER_USERNAME);

    const ran = await runDurableObjectAlarm(w.shard(session));

    expect(ran).toBe(true);
    // 跑完立刻续上下一次：否则心跳只跳一次，会话还是会过期。
    expect(await alarmOf(w.shard(session))).not.toBeNull();
  });

  it("test_the_heartbeat_stops_once_the_socket_is_gone", async () => {
    const w = await world();
    const session = sessionId("gone");
    const target = await open(w, session, CALLER_ID, CALLER_USERNAME);

    target.close();

    // 断开是异步到达服务端的：等它把闹钟撤掉，而不是自己 sleep 一个固定时长。
    const cleared = await waitUntil(async () => (await alarmOf(w.shard(session))) === null);
    expect(cleared).toBe(true);
  });

  it("test_the_connection_metadata_lives_on_the_socket_not_in_memory", async () => {
    const w = await world();
    const session = sessionId("attachment");
    await open(w, session, CALLER_ID, CALLER_USERNAME);

    const attachments = await runInDurableObject(w.shard(session), (_instance, state) =>
      state.getWebSockets().map((socket) => socket.deserializeAttachment() as SocketMeta | null),
    );

    // 会话身份、线格式、订阅偏好全部随连接持久化在平台上：实例被换掉之后，
    // 下一帧回来时不需要任何"重新握手"就能继续按同一套语义服务。
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      tenantId: w.tenant,
      sessionId: session,
      userId: CALLER_ID,
      username: CALLER_USERNAME,
      format: "json",
      wantsStatus: true,
    });
  });

  it("test_cleaning_up_the_same_session_twice_only_notifies_followers_once", async () => {
    const w = await world();
    const callerSession = sessionId("idempotent-watcher");
    const peerSession = sessionId("idempotent");
    const caller = await open(w, callerSession, CALLER_ID, CALLER_USERNAME);
    await registryPost(w.tenant, "/follow", { sessionId: callerSession, userIds: [PEER_ID] });
    await open(w, peerSession, PEER_ID, PEER_USERNAME);

    // 走分片自己的关闭回调（客户端关连接与平台报错走的是同一条路）：
    // 关闭回调不是幂等的调用方，清理逻辑必须自己幂等。
    const closeTwice = async (): Promise<void> => {
      await runInDurableObject(w.shard(peerSession), async (instance, state) => {
        for (const socket of state.getWebSockets()) {
          await instance.webSocketClose!(socket, 1000, "duplicate", true);
        }
      });
    };
    const leaveCount = (): number =>
      caller.frames.filter(
        (envelope) =>
          envelope.message.case === "statusPresenceEvent" &&
          eventKeys(envelope).leaves.includes(`${PEER_ID}/${peerSession}/`),
      ).length;

    await closeTwice();
    const seen = await waitUntil(async () => leaveCount() === 1);
    expect(seen).toBe(true);

    await closeTwice();
    await delay(200);
    expect(leaveCount()).toBe(1);
  });

  it("test_a_session_that_stopped_reporting_is_evicted_and_followers_are_told", async () => {
    const w = await world();
    const callerSession = sessionId("watcher");
    const peerSession = sessionId("silent");
    const caller = await open(w, callerSession, CALLER_ID, CALLER_USERNAME);
    await registryPost(w.tenant, "/follow", { sessionId: callerSession, userIds: [PEER_ID] });
    await open(w, peerSession, PEER_ID, PEER_USERNAME);
    await waitForFrame(
      caller,
      (envelope) =>
        envelope.message.case === "statusPresenceEvent" &&
        eventKeys(envelope).joins.length > 0,
    );

    // 把这条会话的 last_seen 拨回去：等价于"分片没了、心跳再也不会来"。
    await runInDurableObject(w.registry, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE sessions SET last_seen = ? WHERE session_id = ?",
        Date.now() - SESSION_EVICT_AFTER_MS - 1,
        peerSession,
      );
    });

    const ran = await runDurableObjectAlarm(w.registry);

    expect(ran).toBe(true);
    const leave = await waitForFrame(
      caller,
      (envelope) =>
        envelope.message.case === "statusPresenceEvent" &&
        eventKeys(envelope).leaves.includes(`${PEER_ID}/${peerSession}/`),
    );
    expect(eventKeys(leave).leaves).toEqual([`${PEER_ID}/${peerSession}/`]);
  });

  it("test_a_malformed_frame_closes_the_session_and_clears_its_presence", async () => {
    const w = await world();
    const callerSession = sessionId("bad-frame-watcher");
    const peerSession = sessionId("bad-frame");
    const caller = await open(w, callerSession, CALLER_ID, CALLER_USERNAME);
    await registryPost(w.tenant, "/follow", { sessionId: callerSession, userIds: [PEER_ID] });
    const peer = await open(w, peerSession, PEER_ID, PEER_USERNAME);

    // 非 UTF-8 的文本帧：解不出来就断开，不是"当成空消息继续"。
    peer.socket.send(JSON.stringify(pingEnvelope("unused")).slice(0, 5));

    const leave = await waitForFrame(
      caller,
      (envelope) =>
        envelope.message.case === "statusPresenceEvent" &&
        eventKeys(envelope).leaves.includes(`${PEER_ID}/${peerSession}/`),
    );
    expect(eventKeys(leave).leaves).toEqual([`${PEER_ID}/${peerSession}/`]);
  });
});
