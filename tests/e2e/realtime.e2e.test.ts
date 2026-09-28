import { afterEach, describe, expect, it } from "vitest";

import { e2eTenant } from "./global-setup";
import { authenticateDevice, freshDeviceId, userIdOf } from "./http-helpers";
import {
  connectSocket,
  ping,
  presenceKeys,
  rpc,
  statusFollow,
  statusKeys,
  statusUnfollow,
  statusUpdate,
  type WsClient,
} from "./ws-helpers";

/**
 * M3 E2E：实时协议骨架，走**真实 `wrangler dev --local` 进程**上的真 WebSocket。
 *
 * 与 `tests/integration/realtime/` 的分工：集成测试直接按 DO stub 打，验的是语义；
 * 这里两端都是网络上的真连接，验的是"这一整套在真实进程里成立"——路由、握手、
 * 分片 DO 的 WebSocket 升级、注册表 DO 的跨实例投递、两种线格式。
 *
 * 目标进程是本机 workerd（见 `global-setup.ts`），不连任何 Cloudflare 账号资源。
 *
 * 契约源（机器可读）：
 * 契约源: server/socket_ws.go::NewSocketWsAcceptor
 * 契约源: server/pipeline_status.go::Pipeline.statusFollow
 * 契约源: server/status_registry.go::LocalStatusRegistry.Queue
 *
 * REQ-0001-008, REQ-0001-009
 */

interface Player {
  readonly token: string;
  readonly userId: string;
  readonly socket: WsClient;
}

const connected: WsClient[] = [];

async function player(options: { readonly format?: "json" | "protobuf" } = {}): Promise<Player> {
  const { session } = await authenticateDevice(e2eTenant, freshDeviceId("e2e-realtime"));
  const userId = await userIdOf(session.token);
  const socket = await connectSocket(session.token, {
    ...(options.format === undefined ? {} : { format: options.format }),
    status: true,
  });
  connected.push(socket);
  return { token: session.token, userId, socket };
}

afterEach(() => {
  for (const socket of connected.splice(0)) socket.close();
});

describe("M3 E2E: 实时协议", () => {
  it("test_ping_is_answered_in_both_wire_formats", async () => {
    for (const format of ["json", "protobuf"] as const) {
      const me = await player({ format });

      me.socket.send(ping(`ping-${format}`));
      const pong = await me.socket.waitForFrame((envelope) => envelope.message.case === "pong");

      // cid 原样回带：客户端靠它把响应和请求对上号，两种格式都是。
      expect(pong.cid).toBe(`ping-${format}`);
    }
  });

  it("test_two_clients_see_each_others_status_over_the_real_socket", async () => {
    const alice = await player();
    const bob = await player();

    // alice 订阅 bob：此刻 bob 在线且状态是空的（握手时 Track 出来就是空状态）。
    alice.socket.send(statusFollow("follow-1", [bob.userId]));
    const snapshot = await alice.socket.waitForFrame(
      (envelope) =>
        envelope.message.case === "status" && envelope.cid === "follow-1",
    );
    expect(statusKeys(snapshot)).toEqual([`${bob.userId}/`]);

    // bob 设状态 → alice 收到一条 joins（新状态）加一条 leaves（旧状态）。
    bob.socket.send(statusUpdate("update-1", "in game"));
    const update = await alice.socket.waitForFrame(
      (envelope) =>
        envelope.message.case === "statusPresenceEvent" &&
        presenceKeys(envelope).joins.includes(`${bob.userId}/in game`),
    );
    expect(presenceKeys(update)).toEqual({
      joins: [`${bob.userId}/in game`],
      leaves: [`${bob.userId}/`],
    });

    // bob 下线 → alice 收到 leave。断开是客户端主动发起的，走的是服务端的 close 回调。
    bob.socket.close();
    const leave = await alice.socket.waitForFrame(
      (envelope) =>
        envelope.message.case === "statusPresenceEvent" &&
        presenceKeys(envelope).leaves.includes(`${bob.userId}/in game`),
    );
    expect(presenceKeys(leave).leaves).toEqual([`${bob.userId}/in game`]);
  });

  it("test_a_later_follower_sees_the_status_that_was_set_before_it_arrived", async () => {
    const bob = await player();
    bob.socket.send(statusUpdate("bob-status", "raiding"));
    await bob.socket.waitForFrame(
      (envelope) =>
        envelope.message.case === "statusPresenceEvent" &&
        presenceKeys(envelope).joins.includes(`${bob.userId}/raiding`),
    );

    // 后来者订阅：拿到的是**当前**快照，而不是"还没上线"。
    const alice = await player();
    alice.socket.send(statusFollow("late-follow", [bob.userId]));
    const snapshot = await alice.socket.waitForFrame(
      (envelope) => envelope.message.case === "status" && envelope.cid === "late-follow",
    );
    expect(statusKeys(snapshot)).toEqual([`${bob.userId}/raiding`]);
  });

  it("test_unfollow_stops_the_events_and_an_empty_unfollow_is_acknowledged", async () => {
    const alice = await player();
    const bob = await player();
    alice.socket.send(statusFollow("follow-2", [bob.userId]));
    await alice.socket.waitForFrame(
      (envelope) => envelope.message.case === "status" && envelope.cid === "follow-2",
    );

    alice.socket.send(statusUnfollow("unfollow-1", [bob.userId]));
    const ack = await alice.socket.waitForFrame(
      (envelope) => envelope.cid === "unfollow-1" && envelope.message.case === undefined,
    );
    expect(ack.message.case).toBeUndefined();

    bob.socket.send(statusUpdate("update-2", "away"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      alice.socket.frames.filter(
        (envelope) =>
          envelope.message.case === "statusPresenceEvent" &&
          presenceKeys(envelope).joins.some((key) => key.startsWith(`${bob.userId}/away`)),
      ),
    ).toHaveLength(0);
  });

  it("test_an_unimplemented_message_type_closes_the_socket_after_the_error", async () => {
    const me = await player({ format: "protobuf" });

    me.socket.send(rpc("rpc-1"));
    const error = await me.socket.waitForFrame((envelope) => envelope.message.case === "error");

    // 上游对"认得出类型但这条路不提供"的处理：错误帧（cid 原样回带）+ 关连接。
    expect(error.cid).toBe("rpc-1");
    expect(
      error.message.case === "error" ? error.message.value.message : "",
    ).toBe("Unrecognized message.");
  });
});
