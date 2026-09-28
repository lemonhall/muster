import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Error_Code } from "../../../src/realtime/errors";
import { handleEnvelope, type PipelineResult } from "../../../src/realtime/pipeline";
import {
  channelJoinEnvelope,
  channelLeaveEnvelope,
  channelMessageRemoveEnvelope,
  channelMessageSendEnvelope,
  channelMessageUpdateEnvelope,
  recordingChannel,
  type RecordedChannel,
} from "../../helpers/channel";
import {
  ABSENT_ID,
  CALLER_ID,
  CALLER_USERNAME,
  PEER_ID,
  PEER_USERNAME,
  errorOf,
  insertUser,
  onlyReply,
  pipelineContext,
  recordingStatus,
} from "../../helpers/realtime";
import { createTenant } from "../../helpers/tenants";

/**
 * M4 契约测试：频道五个入站帧的**校验顺序与错误文案**（上游 `pipeline_channel.go`）。
 *
 * 这一组刻意用假的 `ChannelService`：管线的职责是"看完就决定说不说、说什么"，
 * 而"频道里到底有谁"是频道 DO 的活儿（在 `join.test.ts` / `presence.test.ts` 里
 * 用真 DO 验）。分开之后，顺序与文案可以逐条钉死，不被 DO 的异步噪声干扰。
 *
 * 两条最容易写歪的规则：
 * 1. `channel_message_update` / `channel_message_remove` **先看 message id**，
 *    再看频道 id——所以两个都非法时客户端看到的是"Invalid message identifier"；
 * 2. 所有失败都是 `BAD_INPUT` 并且**关闭会话**（上游 `ProcessRequest` 返回 false）。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_channel.go::Pipeline.channelJoin
 * 契约源: server/pipeline_channel.go::Pipeline.channelLeave
 * 契约源: server/pipeline_channel.go::Pipeline.channelMessageSend
 * 契约源: server/pipeline_channel.go::Pipeline.channelMessageUpdate
 * 契约源: server/pipeline_channel.go::Pipeline.channelMessageRemove
 *
 * REQ-0001-010
 */

const TENANT = "CCCCCCCC-0000-4000-8000-00000000000C";
const MESSAGE_ID = "11111111-2222-4333-8444-555555555555";

async function seed(): Promise<void> {
  // 每个用例重新摆一遍：`createTenant` 是普通 INSERT（租户 id 与 server key 都是唯一键），
  // 所以先把这个租户的历史行清掉，跑第二次才不会再撞唯一约束。
  await env.DB.prepare("DELETE FROM users WHERE tenant_id = ?1").bind(TENANT).run();
  await env.DB.prepare("DELETE FROM tenants WHERE id = ?1").bind(TENANT).run();
  await createTenant(TENANT, "server-key-channel-validation", "channel-validation");
  await insertUser(TENANT, CALLER_ID, CALLER_USERNAME);
  await insertUser(TENANT, PEER_ID, PEER_USERNAME);
}

interface Harness {
  readonly channel: RecordedChannel;
  readonly send: (envelope: Parameters<typeof handleEnvelope>[1]) => Promise<PipelineResult>;
}

function harness(): Harness {
  const channel = recordingChannel();
  const status = recordingStatus();
  const context = pipelineContext(TENANT, status.service, { channel: channel.service });
  return { channel, send: (envelope) => handleEnvelope(context, envelope) };
}

/** 断言"一帧 BAD_INPUT + 关连接"，并把文案回给调用方做逐字比对。 */
function expectBadInput(result: PipelineResult, message: string): void {
  expect(errorOf(onlyReply(result))).toEqual({ code: Error_Code.BAD_INPUT, message });
  expect(result.close).toBe(true);
}

describe("M4 契约: 频道帧的校验顺序", () => {
  it("test_a_join_without_a_target_is_rejected_before_any_lookup", async () => {
    await seed();
    const { channel, send } = harness();

    const result = await send(channelJoinEnvelope("c-empty", "", 1));

    expectBadInput(result, "Invalid channel target");
    expect(channel.calls).toHaveLength(0);
  });

  it("test_a_room_name_longer_than_64_bytes_is_rejected", async () => {
    await seed();
    const { send } = harness();

    const result = await send(channelJoinEnvelope("c-long", "あ".repeat(22), 1));

    expectBadInput(result, "Channel name is required and must be 1-64 chars: Invalid channel target");
  });

  it("test_a_room_name_with_a_control_character_is_rejected", async () => {
    await seed();
    const { send } = harness();

    const result = await send(channelJoinEnvelope("c-ctrl", "room\u0001name", 1));

    expectBadInput(result, "Channel name must not contain control chars: Invalid channel target");
  });

  it("test_an_unknown_channel_type_is_rejected", async () => {
    await seed();
    const { send } = harness();

    const result = await send(channelJoinEnvelope("c-type", "room-1", 9));

    expectBadInput(result, "Invalid channel type");
  });

  it("test_a_group_join_is_rejected_while_groups_do_not_exist", async () => {
    await seed();
    const { channel, send } = harness();

    const result = await send(channelJoinEnvelope("c-group", crypto.randomUUID(), 3));

    expectBadInput(result, "Group not found: Invalid channel target");
    expect(channel.calls).toHaveLength(0);
  });

  it("test_a_malformed_group_identifier_is_rejected", async () => {
    await seed();
    const { send } = harness();

    const result = await send(channelJoinEnvelope("c-group-bad", "not-a-uuid", 3));

    expectBadInput(result, "Invalid group ID in group channel join: Invalid channel target");
  });

  it("test_a_direct_message_to_a_missing_user_is_rejected", async () => {
    await seed();
    const { send } = harness();

    const result = await send(channelJoinEnvelope("c-dm-missing", ABSENT_ID, 2));

    expectBadInput(result, "User ID not found: Invalid channel target");
  });

  it("test_a_direct_message_to_a_malformed_user_is_rejected", async () => {
    await seed();
    const { send } = harness();

    const result = await send(channelJoinEnvelope("c-dm-bad", "12345", 2));

    expectBadInput(result, "Invalid user ID in direct message join: Invalid channel target");
  });

  it("test_a_leave_with_a_malformed_channel_identifier_is_rejected", async () => {
    await seed();
    const { channel, send } = harness();

    const result = await send(channelLeaveEnvelope("c-leave-bad", "not-a-channel"));

    expectBadInput(result, "Invalid channel identifier");
    expect(channel.calls).toHaveLength(0);
  });

  it("test_a_leave_canonicalises_the_channel_identifier_before_calling_the_service", async () => {
    await seed();
    const { channel, send } = harness();

    const result = await send(
      channelLeaveEnvelope("c-leave", `4.${PEER_ID.toLowerCase()}.${CALLER_ID.toLowerCase()}.`),
    );

    expect(result.close).toBe(false);
    expect(channel.calls).toHaveLength(1);
    const call = channel.calls[0]!;
    expect(call.op).toBe("leave");
    // 大小写被规范成大写的标准形：同一个私聊不会因为客户端写法不同落进两个频道 DO。
    // 注意 subject/subcontext 的**先后顺序不改**（上游解析路径也不排序，排序只发生在 join 建 id 时）。
    expect(call.input).toMatchObject({ channelId: `4.${PEER_ID}.${CALLER_ID}.` });
  });

  it("test_a_message_send_requires_a_json_object_as_content", async () => {
    await seed();
    const { send } = harness();

    const result = await send(channelMessageSendEnvelope("c-send", "2...room-1", "[1,2,3]"));

    expectBadInput(result, "Message content must be a valid JSON object");
  });

  it("test_a_message_send_validates_the_channel_before_the_content", async () => {
    await seed();
    const { send } = harness();

    const result = await send(channelMessageSendEnvelope("c-send-bad", "garbage", "[1]"));

    expectBadInput(result, "Invalid channel identifier");
  });

  it("test_a_message_update_checks_the_message_id_before_the_channel_id", async () => {
    await seed();
    const { send } = harness();

    const result = await send(channelMessageUpdateEnvelope("c-update", "garbage", "nope", "{}"));

    expectBadInput(result, "Invalid message identifier");
  });

  it("test_a_message_remove_checks_the_message_id_before_the_channel_id", async () => {
    await seed();
    const { send } = harness();

    const result = await send(channelMessageRemoveEnvelope("c-remove", "garbage", "nope"));

    expectBadInput(result, "Invalid message identifier");
  });

  it("test_a_service_failure_is_reported_as_a_bad_input_and_closes_the_session", async () => {
    await seed();
    const { channel, send } = harness();
    channel.result = { ok: false, code: "BAD_INPUT", message: "Must join channel before sending messages" };

    const result = await send(channelMessageSendEnvelope("c-not-joined", "2...room-1", "{}"));

    expectBadInput(result, "Must join channel before sending messages");
  });

  it("test_a_runtime_failure_keeps_its_own_error_code", async () => {
    await seed();
    const { channel, send } = harness();
    channel.result = { ok: false, code: "RUNTIME_EXCEPTION", message: "Error joining channel" };

    const result = await send(channelJoinEnvelope("c-runtime", "room-1", 1));

    expect(errorOf(onlyReply(result))).toEqual({
      code: Error_Code.RUNTIME_EXCEPTION,
      message: "Error joining channel",
    });
    expect(result.close).toBe(true);
  });
});
