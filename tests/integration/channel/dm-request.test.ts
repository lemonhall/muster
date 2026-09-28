import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import {
  CALLER,
  PEER,
  channelWorld,
  closeAllWorlds,
  sessionId,
  type ChannelWorld,
} from "../../helpers/channel-world";
import { channelJoinEnvelope } from "../../helpers/channel";
import { sendFrame, waitForFrame, type TestSocket } from "../../helpers/realtime-socket";

/**
 * 私聊里的"想和你聊天"通知（`-1`）。
 *
 * 上游的触发条件只有两条（`pipeline_channel.go::channelJoin` 里那段注释
 * "If the topic join is a DM check if we should notify the other user"）：
 * **这是一次新加入**，且**对方此刻不在这个频道里**。两条都必须成立——
 * 少第一条，每次重连都会刷一条通知；少第二条，人在频道里看着消息还会被通知一遍。
 *
 * 判断在**频道 DO** 里做（只有它知道"对方在不在"），发送在**会话分片**里做
 * （只有它有 `env`）。这个文件从 socket 一路打到数据库，正好覆盖这条跨 DO 的接力。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_channel.go::Pipeline.channelJoin
 * 契约源: server/core_notification.go::NotificationCodeDmRequest
 *
 * REQ-0001-013
 */

afterEach(closeAllWorlds);

interface NotificationDbRow {
  readonly id: string;
  readonly user_id: string;
  readonly subject: string;
  readonly content: string;
  readonly code: number;
  readonly sender_id: string;
}

async function notificationsOf(world: ChannelWorld, userId: string): Promise<NotificationDbRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, user_id, subject, content, code, sender_id FROM notifications
     WHERE tenant_id = ?1 AND user_id = ?2 ORDER BY create_time, id`,
  )
    .bind(world.tenant, userId)
    .all<NotificationDbRow>();
  return result.results;
}

/**
 * 加入私聊频道：`type = 2`（`ChannelJoin.Type.DIRECT`），`target` 是**对方的 user id**，
 * 不是频道 id——频道 id 由服务端把两个 user id 排序后拼出来。
 *
 * 注意别把这里和 **stream mode** 弄混：stream mode 4 才是"私聊"，
 * 而 join 的 type 是另一套枚举（0 未指定 / 1 房间 / 2 私聊 / 3 群组）。
 */
async function joinDirect(socket: TestSocket, cid: string, peerId: string): Promise<void> {
  sendFrame(socket, channelJoinEnvelope(cid, peerId, 2));
  await waitForFrame(socket, (frame) => frame.cid === cid && frame.message.case === "channel");
}

describe("私聊请求通知", () => {
  it("notifies the peer once when the other side opens the conversation", async () => {
    const world = await channelWorld();
    const caller = await world.open(sessionId("dm-caller"), CALLER.id, CALLER.username);

    await joinDirect(caller, "c-dm-1", PEER.id);

    const rows = await notificationsOf(world, PEER.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.code).toBe(-1);
    expect(rows[0]?.subject).toBe(`${CALLER.username} wants to chat`);
    expect(JSON.parse(rows[0]?.content ?? "{}")).toEqual({ username: CALLER.username });
    expect(rows[0]?.sender_id).toBe(CALLER.id);
    // 发起者自己不会收到这条通知。
    expect(await notificationsOf(world, CALLER.id)).toHaveLength(0);
  });

  it("does not notify again when the same session joins a second time", async () => {
    const world = await channelWorld();
    const caller = await world.open(sessionId("dm-repeat"), CALLER.id, CALLER.username);

    await joinDirect(caller, "c-dm-a", PEER.id);
    await joinDirect(caller, "c-dm-b", PEER.id);

    // 重复 join 是"关系已存在"的早返回：不更新 meta、不发事件、也不发通知。
    expect(await notificationsOf(world, PEER.id)).toHaveLength(1);
  });

  it("stays silent when the peer is already in the channel", async () => {
    const world = await channelWorld();
    const peer = await world.open(sessionId("dm-peer"), PEER.id, PEER.username);
    const caller = await world.open(sessionId("dm-late"), CALLER.id, CALLER.username);

    // 对方先到：他自己那一次加入会通知 CALLER（CALLER 不在频道里）。
    await joinDirect(peer, "c-dm-peer", CALLER.id);
    expect(await notificationsOf(world, CALLER.id)).toHaveLength(1);

    // CALLER 后到：PEER 在频道里，所以不再给 PEER 发"想和你聊天"。
    await joinDirect(caller, "c-dm-late", PEER.id);
    expect(await notificationsOf(world, PEER.id)).toHaveLength(0);
  });
});
