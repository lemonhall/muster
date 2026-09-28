import { afterEach, describe, expect, it } from "vitest";

import { Error_Code } from "../../../src/realtime/errors";
import { channelJoinEnvelope, channelReply, channelEventKeys } from "../../helpers/channel";
import {
  CALLER,
  PEER,
  channelWorld,
  closeAllWorlds,
  roomChannelId,
  sessionId,
} from "../../helpers/channel-world";
import { errorOf } from "../../helpers/realtime";
import {
  expectNoNewFrame,
  sendFrame,
  waitForFrame,
  type TestSocket,
} from "../../helpers/realtime-socket";
import type { Envelope } from "../../../src/proto/realtime_pb";

/**
 * M4 契约测试：`channel_join` 的三类频道语义，走**真 WebSocket + 真频道 DO**。
 *
 * 与 `validation.test.ts` 的分工：那边用假服务钉"校验顺序与文案"，这边用整套真管线
 * 钉"进去之后看见了什么"——快照里有没有自己、重复加入会不会改 meta、隐藏成员算不算成员。
 *
 * 三条上游规则在这里被反复验证（`LocalTracker.Track` 与 `channelJoin`）：
 * 1. `channel` 回执里 **presences 不含"刚加入的自己"**（因为上游是先 Track 再取快照，
 *    取快照时会把自己的那条排掉），而**重复加入**时自己在快照里；
 * 2. `hidden` 的成员不在快照里、也不产生 `channel_presence_event`，但**仍然是成员**
 *    （能收消息，见 `messages.test.ts`）；
 * 3. `persistence` 缺省是 true；它决定消息是否落盘（`messages.test.ts`），
 *    在 presence 上只是那个 `persistent` 位。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_channel.go::Pipeline.channelJoin
 * 契约源: server/tracker.go::LocalTracker.Track
 *
 * REQ-0001-010
 */

/**
 * 等一条"某人加入"的事件。
 *
 * 上游如此：**加入者自己也会收到自己的 joins 事件**——上游 `processEvent` 的收件人是
 * `ListLocalSessionIDByStream(stream)`，那是在 `Track` **之后**取的，所以新加入者也在里面。
 * 于是"等 alice 看到 bob 加入"必须按 userId 过滤，不能只看"来了一条 presence 事件"。
 */
function joinsEventOf(userId: string) {
  return (frame: Envelope): boolean =>
    frame.message.case === "channelPresenceEvent" &&
    frame.message.value.joins.some((presence) => presence.userId === userId);
}

/** 把自己那条加入事件收干净，后面的负向断言才不会被它绊倒。 */
async function settleOwnJoin(target: TestSocket): Promise<void> {
  await waitForFrame(target, joinsEventOf(CALLER.id));
}

function presenceEvent(frame: Envelope): boolean {
  return frame.message.case === "channelPresenceEvent";
}

afterEach(closeAllWorlds);

describe("M4 契约: 加入频道", () => {
  it("test_a_room_join_answers_with_the_channel_and_only_its_own_presence", async () => {
    const world = await channelWorld();
    const session = sessionId("room");
    const caller = await world.open(session, CALLER.id, CALLER.username);

    sendFrame(caller, channelJoinEnvelope("j1", "room-1"));
    const reply = channelReply(
      await waitForFrame(caller, (frame) => frame.cid === "j1" && frame.message.case === "channel"),
    );

    expect(reply.channelId).toBe(roomChannelId("room-1"));
    expect(reply.self).toBe(`${CALLER.id}/${session}/p`);
    // 刚加入时快照里没有自己——上游 "new join" 的那条分支把自己排掉了。
    expect(reply.presences).toEqual([]);
  });

  it("test_an_unspecified_channel_type_joins_a_room", async () => {
    const world = await channelWorld();
    const caller = await world.open(sessionId("unspecified"), CALLER.id, CALLER.username);

    // type = 0（TYPE_UNSPECIFIED）在上游是 fallthrough 到 ROOM，不是"非法类型"。
    sendFrame(caller, channelJoinEnvelope("j1", "room-1", 0));
    const reply = channelReply(
      await waitForFrame(caller, (frame) => frame.cid === "j1" && frame.message.case === "channel"),
    );

    expect(reply.channelId).toBe(roomChannelId("room-1"));
  });

  it("test_joining_the_same_room_twice_reports_the_member_in_the_snapshot", async () => {
    const world = await channelWorld();
    const session = sessionId("twice");
    const caller = await world.open(session, CALLER.id, CALLER.username);

    sendFrame(caller, channelJoinEnvelope("j1", "room-twice"));
    await waitForFrame(caller, (frame) => frame.cid === "j1" && frame.message.case === "channel");
    await settleOwnJoin(caller);
    sendFrame(caller, channelJoinEnvelope("j2", "room-twice"));
    const second = channelReply(
      await waitForFrame(caller, (frame) => frame.cid === "j2" && frame.message.case === "channel"),
    );

    expect(second.presences).toEqual([`${CALLER.id}/${session}/p`]);
    // 重复加入**不改 meta、不发事件**（上游 Track 的 alreadyTracked 早返回）。
    await expectNoNewFrame(caller, presenceEvent);
  });

  it("test_a_non_persistent_join_reports_persistence_false", async () => {
    const world = await channelWorld();
    const session = sessionId("ephemeral");
    const caller = await world.open(session, CALLER.id, CALLER.username);

    sendFrame(caller, channelJoinEnvelope("j1", "room-ephemeral", 1, { persistence: false }));
    const reply = channelReply(
      await waitForFrame(caller, (frame) => frame.cid === "j1" && frame.message.case === "channel"),
    );

    expect(reply.self).toBe(`${CALLER.id}/${session}/-`);
  });

  it("test_a_second_client_sees_the_first_member_and_announces_itself", async () => {
    const world = await channelWorld();
    const aliceSession = sessionId("alice");
    const bobSession = sessionId("bob");
    const alice = await world.open(aliceSession, CALLER.id, CALLER.username);
    const bob = await world.open(bobSession, PEER.id, PEER.username);

    sendFrame(alice, channelJoinEnvelope("a1", "room-two"));
    await waitForFrame(alice, (frame) => frame.cid === "a1" && frame.message.case === "channel");
    await settleOwnJoin(alice);
    sendFrame(bob, channelJoinEnvelope("b1", "room-two"));
    const reply = channelReply(
      await waitForFrame(bob, (frame) => frame.cid === "b1" && frame.message.case === "channel"),
    );

    expect(reply.presences).toEqual([`${CALLER.id}/${aliceSession}/p`]);
    // alice 收到的是"bob 加入"（不许和下一条混）。
    const event = await waitForFrame(alice, joinsEventOf(PEER.id));
    expect(channelEventKeys(event).joins).toEqual([`${PEER.id}/${bobSession}/p`]);
  });

  it("test_a_hidden_member_is_absent_from_snapshots_and_events", async () => {
    const world = await channelWorld();
    const alice = await world.open(sessionId("watching"), CALLER.id, CALLER.username);
    const invisible = await world.open(sessionId("hidden"), PEER.id, PEER.username);
    const late = await world.open(sessionId("late"), CALLER.id, CALLER.username);

    sendFrame(alice, channelJoinEnvelope("a1", "room-hidden"));
    await waitForFrame(alice, (frame) => frame.cid === "a1" && frame.message.case === "channel");
    await settleOwnJoin(alice);

    sendFrame(invisible, channelJoinEnvelope("h1", "room-hidden", 1, { hidden: true }));
    const hiddenReply = channelReply(
      await waitForFrame(invisible, (frame) => frame.cid === "h1" && frame.message.case === "channel"),
    );
    // 隐藏成员自己看得到快照里的别人，但别人看不到他，也没有 joins 事件。
    expect(hiddenReply.presences).toEqual([`${CALLER.id}/${alice.sessionId}/p`]);
    await expectNoNewFrame(alice, presenceEvent);

    sendFrame(late, channelJoinEnvelope("l1", "room-hidden"));
    const lateReply = channelReply(
      await waitForFrame(late, (frame) => frame.cid === "l1" && frame.message.case === "channel"),
    );
    expect(lateReply.presences).toEqual([`${CALLER.id}/${alice.sessionId}/p`]);
  });

  it("test_a_direct_message_join_uses_the_pair_as_the_channel_identifier", async () => {
    const world = await channelWorld();
    const session = sessionId("dm");
    const caller = await world.open(session, CALLER.id, CALLER.username);

    sendFrame(caller, channelJoinEnvelope("d1", PEER.id, 2));
    const reply = channelReply(
      await waitForFrame(caller, (frame) => frame.cid === "d1" && frame.message.case === "channel"),
    );

    // 上游把两个 uid 排序后写进 subject/subcontext（`BuildChannelId` 的 DM 分支）。
    const [first, second] = CALLER.id > PEER.id ? [PEER.id, CALLER.id] : [CALLER.id, PEER.id];
    expect(reply.channelId).toBe(`4.${first}.${second}.`);
    expect(reply.self).toBe(`${CALLER.id}/${session}/p`);
  });

  it("test_a_group_join_is_rejected_and_the_session_is_closed", async () => {
    const world = await channelWorld();
    const caller = await world.open(sessionId("group"), CALLER.id, CALLER.username);

    sendFrame(caller, channelJoinEnvelope("g1", crypto.randomUUID(), 3));
    const error = await waitForFrame(caller, (frame) => frame.cid === "g1");

    expect(errorOf(error)).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Group not found: Invalid channel target",
    });
  });
});
