import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import { EnvelopeSchema, PongSchema } from "../../../src/proto/realtime_pb";
import { Error_Code } from "../../../src/realtime/errors";
import { handleEnvelope } from "../../../src/realtime/pipeline";
import {
  errorOf,
  onlyReply,
  pingEnvelope,
  pipelineContext,
  recordingStatus,
  rpcEnvelope,
  statusFollowEnvelope,
} from "../../helpers/realtime";
import { channelJoinEnvelope, recordingChannel } from "../../helpers/channel";
import { TENANT_A } from "../../helpers/tenants";

/**
 * M3 契约测试：心跳、空帧、以及"这条路还没接通"的消息类型。
 *
 * 这里的每一条断言都逐字对齐上游 `server/pipeline.go` 的 `ProcessRequest`：
 * 消息缺失 → `MISSING_PAYLOAD "Missing message."`；认得出类型但没有处理函数 →
 * `UNRECOGNIZED_PAYLOAD "Unrecognized message."`；两者的共同点是**回完错误帧就关连接**
 * （`ProcessRequest` 返回 false，`sessionWS.consume` 随即跳出读循环）。
 *
 * `ping` / `pong` 来自 `server/pipeline_ping.go`：ping 原样回带 cid，pong 什么都不做。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline.go::Pipeline.ProcessRequest
 * 契约源: server/pipeline_ping.go::Pipeline.ping
 * 契约源: server/pipeline_ping.go::Pipeline.pong
 *
 * REQ-0001-008
 */

describe("M3 契约: 心跳与未接通的消息类型", () => {
  it("test_ping_is_answered_by_a_pong_carrying_the_same_cid", async () => {
    const status = recordingStatus();

    const result = await handleEnvelope(
      pipelineContext(TENANT_A, status.service),
      pingEnvelope("c-ping"),
    );

    expect(result.close).toBe(false);
    expect(result.replies).toHaveLength(1);
    expect(onlyReply(result).cid).toBe("c-ping");
    expect(onlyReply(result).message.case).toBe("pong");
  });

  it("test_pong_is_a_no_op_that_keeps_the_session_open", async () => {
    const status = recordingStatus();
    const pong = create(EnvelopeSchema, {
      cid: "c-pong",
      message: { case: "pong", value: create(PongSchema, {}) },
    });

    const result = await handleEnvelope(pipelineContext(TENANT_A, status.service), pong);

    expect(result.replies).toHaveLength(0);
    expect(result.close).toBe(false);
  });

  it("test_an_envelope_without_any_message_closes_the_session_with_missing_payload", async () => {
    const status = recordingStatus();
    // 只有 cid 的信封：上游 `in.Message == nil` 的那条分支。
    const empty = create(EnvelopeSchema, { cid: "c-empty" });

    const result = await handleEnvelope(pipelineContext(TENANT_A, status.service), empty);

    expect(errorOf(onlyReply(result))).toEqual({
      code: Error_Code.MISSING_PAYLOAD,
      message: "Missing message.",
    });
    expect(onlyReply(result).cid).toBe("c-empty");
    expect(result.close).toBe(true);
  });

  it("test_channel_frames_reach_the_channel_service_instead_of_the_fallback", async () => {
    // M4 起 `channel_join` 走 `pipeline_channel.go` 那条路：校验通过后交给频道服务，
    // 不再落进"认得出类型但没有处理函数"的兜底分支（那是 M3 的临时行为，见 ECN-0006）。
    const status = recordingStatus();
    const channel = recordingChannel();

    const result = await handleEnvelope(
      pipelineContext(TENANT_A, status.service, { channel: channel.service }),
      channelJoinEnvelope("c-join", "room-1"),
    );

    expect(channel.calls.map((call) => call.op)).toEqual(["join"]);
    expect(result.replies).toHaveLength(0);
    expect(result.close).toBe(false);
  });

  it("test_rpc_is_a_placeholder_for_now_and_closes_the_session", async () => {
    const status = recordingStatus();

    const result = await handleEnvelope(
      pipelineContext(TENANT_A, status.service),
      rpcEnvelope("c-rpc"),
    );

    expect(errorOf(onlyReply(result))).toEqual({
      code: Error_Code.UNRECOGNIZED_PAYLOAD,
      message: "Unrecognized message.",
    });
    expect(result.close).toBe(true);
  });

  it("test_status_requests_with_malformed_input_are_rejected_before_any_lookup", async () => {
    const status = recordingStatus();

    const result = await handleEnvelope(
      pipelineContext(TENANT_A, status.service),
      statusFollowEnvelope("c-bad-id", { userIds: ["definitely-not-a-uuid"] }),
    );

    expect(errorOf(onlyReply(result))).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Invalid user identifier",
    });
    expect(result.close).toBe(true);
    // 校验失败就不该走到注册表——否则会先订阅再报错，留下一个谁也不认识的订阅。
    expect(status.follows).toHaveLength(0);
  });

  it("test_status_follow_rejects_an_empty_username", async () => {
    const status = recordingStatus();

    const result = await handleEnvelope(
      pipelineContext(TENANT_A, status.service),
      statusFollowEnvelope("c-bad-name", { usernames: [""] }),
    );

    expect(errorOf(onlyReply(result))).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Invalid username",
    });
    expect(result.close).toBe(true);
    expect(status.follows).toHaveLength(0);
  });
});
