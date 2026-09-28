import { afterEach, describe, expect, it } from "vitest";

import { Error_Code } from "../../../src/realtime/errors";
import {
  channelAckOf,
  channelJoinEnvelope,
  channelMessageOf,
  channelMessageRemoveEnvelope,
  channelMessageSendEnvelope,
  channelMessageUpdateEnvelope,
  joinRoom,
  sendChannelMessage,
} from "../../helpers/channel";
import {
  CALLER,
  PEER,
  channelWorld,
  closeAllWorlds,
  listChannelHistory,
  roomChannelId,
  sessionId,
} from "../../helpers/channel-world";
import { errorOf } from "../../helpers/realtime";
import { sendFrame, waitForFrame, type TestSocket } from "../../helpers/realtime-socket";

/**
 * M4 契约测试：频道消息的**发送 / 修改 / 删除**，走真 WebSocket + 真频道 DO。
 *
 * 这一组钉住上游 `pipeline_channel.go` 的四条可观测行为：
 *
 * 1. 发送成功后**两条帧**：广播（无 cid，给频道里所有人）与回执（带 cid，只给发送者），
 *    顺序是**先广播、后回执**；
 * 2. 回执**不带** sender_id 与 content（上游构造 ack 时就没填这两个字段）；
 * 3. 只有**发送者**能改删：SQL 的 `WHERE id = $1 AND sender_id = $2` 改不到行时，
 *    回的是"历史里没有这条"；
 * 4. 非持久化频道**不落盘**，但广播照发；上游对非持久化频道的改删**不查表**，
 *    所以那条路径上"消息不存在"不会报错（这个反直觉的行为也钉住）。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_channel.go::Pipeline.channelMessageSend
 * 契约源: server/pipeline_channel.go::Pipeline.channelMessageUpdate
 * 契约源: server/pipeline_channel.go::Pipeline.channelMessageRemove
 * 契约源: server/core_channel.go::ChannelMessageSend
 *
 * REQ-0001-010
 */

afterEach(closeAllWorlds);

describe("M4 契约: 频道消息", () => {
  it("test_a_message_is_broadcast_to_the_others_and_acknowledged_to_the_sender", async () => {
    const world = await channelWorld();
    const alice = await world.open(sessionId("sender"), CALLER.id, CALLER.username);
    const bob = await world.open(sessionId("receiver"), PEER.id, PEER.username);
    const room = roomChannelId("room-chat");
    await joinRoom(alice, "a1", "room-chat");
    await joinRoom(bob, "b1", "room-chat");

    const messageId = await sendChannelMessage(alice, "m1", room, '{"hello":"world"}');

    const broadcast = channelMessageOf(
      await waitForFrame(bob, (frame) => frame.message.case === "channelMessage"),
    );
    expect(broadcast).toEqual({
      messageId,
      channelId: room,
      code: 0,
      senderId: CALLER.id,
      username: CALLER.username,
      content: '{"hello":"world"}',
      persistent: true,
    });

    const ack = channelAckOf(
      await waitForFrame(alice, (frame) => frame.cid === "m1" && frame.message.case === "channelMessageAck"),
    );
    expect(ack).toEqual({
      messageId,
      channelId: room,
      code: 0,
      username: CALLER.username,
      persistent: true,
    });
  });

  it("test_the_sender_receives_its_own_broadcast_before_the_acknowledgement", async () => {
    const world = await channelWorld();
    const alice = await world.open(sessionId("echo"), CALLER.id, CALLER.username);
    const room = roomChannelId("room-echo");
    await joinRoom(alice, "a1", "room-echo");

    await sendChannelMessage(alice, "m1", room, "{}");
    await waitForFrame(alice, (frame) => frame.message.case === "channelMessageAck");

    const cases = alice.frames
      .filter((frame) => frame.message.case === "channelMessage" || frame.message.case === "channelMessageAck")
      .map((frame) => frame.message.case);
    expect(cases).toEqual(["channelMessage", "channelMessageAck"]);
  });

  it("test_the_sender_can_update_a_message_and_the_code_says_chat_update", async () => {
    const world = await channelWorld();
    const alice = await world.open(sessionId("editor"), CALLER.id, CALLER.username);
    const bob = await world.open(sessionId("editor-watcher"), PEER.id, PEER.username);
    const room = roomChannelId("room-edit");
    await joinRoom(alice, "a1", "room-edit");
    await joinRoom(bob, "b1", "room-edit");
    const messageId = await sendChannelMessage(alice, "m1", room, '{"v":1}');

    sendFrame(alice, channelMessageUpdateEnvelope("m2", room, messageId, '{"v":2}'));

    const updated = await waitForFrame(
      bob,
      (frame) => frame.message.case === "channelMessage" && frame.message.value.code === 1,
    );
    const shape = channelMessageOf(updated);
    expect(shape.messageId).toBe(messageId);
    expect(shape.content).toBe('{"v":2}');
    expect(shape.code).toBe(1);

    const ack = channelAckOf(
      await waitForFrame(alice, (frame) => frame.cid === "m2" && frame.message.case === "channelMessageAck"),
    );
    expect(ack.code).toBe(1);
    expect(ack.messageId).toBe(messageId);
  });

  it("test_only_the_sender_can_update_a_message", async () => {
    const world = await channelWorld();
    const alice = await world.open(sessionId("owner"), CALLER.id, CALLER.username);
    const bob = await world.open(sessionId("intruder"), PEER.id, PEER.username);
    const room = roomChannelId("room-owner");
    await joinRoom(alice, "a1", "room-owner");
    await joinRoom(bob, "b1", "room-owner");
    const messageId = await sendChannelMessage(alice, "m1", room, '{"v":1}');
    await waitForFrame(bob, (frame) => frame.message.case === "channelMessage");

    sendFrame(bob, channelMessageUpdateEnvelope("m2", room, messageId, '{"v":99}'));

    const error = await waitForFrame(bob, (frame) => frame.cid === "m2");
    expect(errorOf(error)).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Could not find message to update in channel history",
    });
  });

  it("test_the_sender_can_remove_a_message_and_the_content_becomes_an_empty_object", async () => {
    const world = await channelWorld();
    const alice = await world.open(sessionId("remover"), CALLER.id, CALLER.username);
    const bob = await world.open(sessionId("remover-watcher"), PEER.id, PEER.username);
    const room = roomChannelId("room-remove");
    await joinRoom(alice, "a1", "room-remove");
    await joinRoom(bob, "b1", "room-remove");
    const messageId = await sendChannelMessage(alice, "m1", room, '{"secret":"value"}');

    sendFrame(alice, channelMessageRemoveEnvelope("m2", room, messageId));

    const removed = await waitForFrame(
      bob,
      (frame) => frame.message.case === "channelMessage" && frame.message.value.code === 2,
    );
    const shape = channelMessageOf(removed);
    expect(shape.messageId).toBe(messageId);
    // 删除帧的内容恒为 `{}`：告诉别人"这条没了"，但不把原文再发一遍。
    expect(shape.content).toBe("{}");
    expect(shape.code).toBe(2);
  });

  it("test_a_removal_by_someone_else_is_rejected", async () => {
    const world = await channelWorld();
    const alice = await world.open(sessionId("owner-remove"), CALLER.id, CALLER.username);
    const bob = await world.open(sessionId("intruder-remove"), PEER.id, PEER.username);
    const room = roomChannelId("room-owner-remove");
    await joinRoom(alice, "a1", "room-owner-remove");
    await joinRoom(bob, "b1", "room-owner-remove");
    const messageId = await sendChannelMessage(alice, "m1", room, "{}");
    await waitForFrame(bob, (frame) => frame.message.case === "channelMessage");

    sendFrame(bob, channelMessageRemoveEnvelope("m2", room, messageId));

    expect(errorOf(await waitForFrame(bob, (frame) => frame.cid === "m2"))).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Could not find message to remove in channel history",
    });
  });

  it("test_sending_without_joining_is_rejected", async () => {
    const world = await channelWorld();
    const stranger = await world.open(sessionId("stranger"), CALLER.id, CALLER.username);

    sendFrame(stranger, channelMessageSendEnvelope("m1", roomChannelId("room-stranger"), "{}"));

    expect(errorOf(await waitForFrame(stranger, (frame) => frame.cid === "m1"))).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Must join channel before sending messages",
    });
  });

  it("test_a_hidden_member_still_receives_messages", async () => {
    const world = await channelWorld();
    const alice = await world.open(sessionId("loud"), CALLER.id, CALLER.username);
    const ghost = await world.open(sessionId("quiet"), PEER.id, PEER.username);
    const room = roomChannelId("room-quiet");
    await joinRoom(alice, "a1", "room-quiet");
    await joinRoom(ghost, "g1", "room-quiet", { hidden: true });

    await sendChannelMessage(alice, "m1", room, '{"still":"delivered"}');

    const delivered = channelMessageOf(
      await waitForFrame(ghost, (frame) => frame.message.case === "channelMessage"),
    );
    expect(delivered.content).toBe('{"still":"delivered"}');
  });

  it("test_a_non_persistent_channel_broadcasts_but_does_not_store", async () => {
    const world = await channelWorld();
    const alice = await world.open(sessionId("ephemeral-sender"), CALLER.id, CALLER.username);
    const bob = await world.open(sessionId("ephemeral-receiver"), PEER.id, PEER.username);
    const room = roomChannelId("room-nostore");
    await joinRoom(alice, "a1", "room-nostore", { persistence: false });
    await joinRoom(bob, "b1", "room-nostore");

    const messageId = await sendChannelMessage(alice, "m1", room, '{"gone":"soon"}');

    // 广播照发，`persistent` 位是 false——客户端据此知道这条不会被写进历史。
    const broadcast = channelMessageOf(
      await waitForFrame(bob, (frame) => frame.message.case === "channelMessage"),
    );
    expect(broadcast.persistent).toBe(false);
    expect(broadcast.messageId).toBe(messageId);

    const response = await listChannelHistory(world, room, "?limit=100");
    expect(await response.json()).toEqual({});
  });

  it("test_a_non_persistent_update_does_not_touch_the_history", async () => {
    const world = await channelWorld();
    const alice = await world.open(sessionId("ephemeral-editor"), CALLER.id, CALLER.username);
    const room = roomChannelId("room-nostore-edit");
    await joinRoom(alice, "a1", "room-nostore-edit", { persistence: false });

    // 一个从没存在过的 message id：非持久化路径不查表（上游 `meta.Persistence` 为假时直接构造帧），
    // 所以这里**不会**报"历史里没有这条"。反直觉，但这是上游行为。
    sendFrame(alice, channelMessageUpdateEnvelope("m1", room, crypto.randomUUID(), '{"v":2}'));

    const ack = channelAckOf(
      await waitForFrame(alice, (frame) => frame.cid === "m1" && frame.message.case === "channelMessageAck"),
    );
    expect(ack.code).toBe(1);
    expect(ack.persistent).toBe(false);
  });
});
