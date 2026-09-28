import { afterEach, describe, expect, it } from "vitest";

import {
  channelJoinEnvelope,
  channelLeaveEnvelope,
  channelEventKeys,
  channelReply,
} from "../../helpers/channel";
import {
  CALLER,
  PEER,
  channelWorld,
  closeAllWorlds,
  roomChannelId,
  sessionId,
} from "../../helpers/channel-world";
import { onlyReply } from "../../helpers/realtime";
import {
  delay,
  expectNoNewFrame,
  sendFrame,
  waitForFrame,
  type TestSocket,
} from "../../helpers/realtime-socket";
import type { Envelope } from "../../../src/proto/realtime_pb";

/**
 * M4 契约测试：频道的**上下线事件**——谁会被通知、通知里有什么、什么时候不通知。
 *
 * 这一组钉的是上游 `LocalTracker` 的三条规则（`Track` / `Untrack` / `UntrackAll`）：
 *
 * 1. 加入/离开都广播给**频道里所有人**（包括发起者自己——收件人是 Track 之后的成员表，
 *    见 `join.test.ts` 的说明）；
 * 2. `hidden` 的成员**不产生事件**（既不 announce 加入，也不 announce 离开），
 *    但仍然是成员：消息照收（`messages.test.ts`）；
 * 3. 连接断开等价于"这条会话在这个频道里的全部 presence 一起摘掉"
 *    （`sessionWS.consume` → `UntrackAll`）。
 *
 * 第 3 条是本项目的**登记偏差**：上游 `UntrackAll` 只在会话分片自己的生命周期里被调用，
 * 而本项目把成员表放在频道 DO 里，所以由分片在 `#disconnect` 里逐频道通知（ECN-0007）。
 * 行为上比上游更完整（平台硬杀分片时上游会留下幽灵成员），所以这条偏差是"更正确"的方向。
 *
 * 契约源（机器可读）：
 * 契约源: server/tracker.go::LocalTracker.Untrack
 * 契约源: server/tracker.go::LocalTracker.UntrackAll
 * 契约源: server/session_ws.go::sessionWS.Close
 *
 * REQ-0001-010
 */

function joinsEventOf(userId: string) {
  return (frame: Envelope): boolean =>
    frame.message.case === "channelPresenceEvent" &&
    frame.message.value.joins.some((presence) => presence.userId === userId);
}

function leavesEventOf(userId: string) {
  return (frame: Envelope): boolean =>
    frame.message.case === "channelPresenceEvent" &&
    frame.message.value.leaves.some((presence) => presence.userId === userId);
}

function presenceEvent(frame: Envelope): boolean {
  return frame.message.case === "channelPresenceEvent";
}

async function join(
  target: TestSocket,
  cid: string,
  room: string,
  options: { readonly hidden?: boolean } = {},
): Promise<string> {
  sendFrame(target, channelJoinEnvelope(cid, room, 1, options));
  const reply = channelReply(
    await waitForFrame(target, (frame) => frame.cid === cid && frame.message.case === "channel"),
  );
  return reply.channelId;
}

afterEach(closeAllWorlds);

describe("M4 契约: 频道上下线事件", () => {
  it("test_a_leave_is_acknowledged_with_an_empty_envelope_and_announced_to_the_others", async () => {
    const world = await channelWorld();
    const alice = await world.open(sessionId("leaver-watcher"), CALLER.id, CALLER.username);
    const bob = await world.open(sessionId("leaver"), PEER.id, PEER.username);

    await join(alice, "a1", "room-leave");
    await join(bob, "b1", "room-leave");
    await waitForFrame(alice, joinsEventOf(PEER.id));

    sendFrame(bob, channelLeaveEnvelope("b2", roomChannelId("room-leave")));
    const ack = await waitForFrame(bob, (frame) => frame.cid === "b2");
    // 回执是空信封：上游 `channelLeave` 只把 cid 带回去，没有任何 payload。
    expect(ack.cid).toBe("b2");
    expect(ack.message.case).toBeUndefined();

    const leave = await waitForFrame(alice, leavesEventOf(PEER.id));
    expect(channelEventKeys(leave).leaves).toEqual([`${PEER.id}/${bob.sessionId}/p`]);
  });

  it("test_leaving_a_channel_that_was_never_joined_is_a_silent_ack", async () => {
    const world = await channelWorld();
    const alice = await world.open(sessionId("never-joined"), CALLER.id, CALLER.username);
    const watcher = await world.open(sessionId("watching-nobody"), PEER.id, PEER.username);

    await join(watcher, "w1", "room-never");
    sendFrame(alice, channelLeaveEnvelope("l1", roomChannelId("room-never")));
    const ack = await waitForFrame(alice, (frame) => frame.cid === "l1");

    expect(ack.message.case).toBeUndefined();
    // 上游 Untrack 的早返回：没 track 过就什么都不广播。
    await expectNoNewFrame(watcher, presenceEvent);
  });

  it("test_a_hidden_member_leaves_without_announcing_anything", async () => {
    const world = await channelWorld();
    const alice = await world.open(sessionId("hidden-watcher"), CALLER.id, CALLER.username);
    const ghost = await world.open(sessionId("ghost"), PEER.id, PEER.username);

    await join(alice, "a1", "room-ghost");
    await join(ghost, "g1", "room-ghost", { hidden: true });
    await expectNoNewFrame(alice, presenceEvent);

    sendFrame(ghost, channelLeaveEnvelope("g2", roomChannelId("room-ghost")));
    await waitForFrame(ghost, (frame) => frame.cid === "g2");

    await expectNoNewFrame(alice, presenceEvent);
  });

  it("test_closing_the_socket_removes_every_presence_of_that_session", async () => {
    const world = await channelWorld();
    const alice = await world.open(sessionId("disconnect-watcher"), CALLER.id, CALLER.username);
    const bob = await world.open(sessionId("disconnect"), PEER.id, PEER.username);

    await join(alice, "a1", "room-disconnect");
    await join(bob, "b1", "room-disconnect");
    await waitForFrame(alice, joinsEventOf(PEER.id));

    bob.close();

    const leave = await waitForFrame(alice, leavesEventOf(PEER.id));
    expect(channelEventKeys(leave).leaves).toEqual([`${PEER.id}/${bob.sessionId}/p`]);
  });

  it("test_a_session_in_two_channels_leaves_both_on_disconnect", async () => {
    const world = await channelWorld();
    const alice = await world.open(sessionId("two-channel-watcher"), CALLER.id, CALLER.username);
    const bob = await world.open(sessionId("two-channel"), PEER.id, PEER.username);

    await join(alice, "a1", "room-one-of-two");
    await join(alice, "a2", "room-two-of-two");
    await join(bob, "b1", "room-one-of-two");
    await join(bob, "b2", "room-two-of-two");
    await waitForFrame(alice, joinsEventOf(PEER.id));

    bob.close();

    // 两条离开事件（每个频道一条），而不是合并成一条：上游 UntrackAll 逐流发 leave。
    const first = await waitForFrame(alice, leavesEventOf(PEER.id));
    const deadline = Date.now() + 2000;
    let second: Envelope | undefined;
    while (Date.now() < deadline) {
      second = alice.frames.filter(leavesEventOf(PEER.id))[1];
      if (second !== undefined) break;
      await delay(20);
    }
    if (second === undefined) throw new Error("第二条离开事件没到");
    const ids = [first, second].map((frame) =>
      frame.message.case === "channelPresenceEvent" ? frame.message.value.channelId : "",
    );
    expect(ids.sort()).toEqual([roomChannelId("room-one-of-two"), roomChannelId("room-two-of-two")].sort());
  });

  it("test_the_same_room_name_in_another_tenant_is_a_different_channel", async () => {
    const world = await channelWorld();
    const alice = await world.open(sessionId("tenant-a"), CALLER.id, CALLER.username);
    const foreign = await world.openIn(
      world.otherTenant,
      sessionId("tenant-b"),
      PEER.id,
      PEER.username,
    );

    await join(alice, "a1", "room-shared-name");

    // 换个租户进"同名房间"：频道的键含租户，所以这是另一个 DO，谁也看不见谁。
    const foreignChannelId = roomChannelId("room-shared-name");
    sendFrame(foreign, channelJoinEnvelope("f1", "room-shared-name"));
    const reply = channelReply(
      await waitForFrame(foreign, (frame) => frame.cid === "f1" && frame.message.case === "channel"),
    );
    expect(reply.channelId).toBe(foreignChannelId);
    expect(reply.presences).toEqual([]);
    await expectNoNewFrame(alice, presenceEvent);
  });
});
