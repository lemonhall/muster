import { describe, expect, it } from "vitest";

import { Error_Code } from "../../../src/realtime/errors";
import { handleEnvelope } from "../../../src/realtime/pipeline";
import { uuidV5, NAMESPACE_DNS } from "../../../src/domain/uuid";
import { errorOf, onlyReply, pipelineContext, recordingStatus } from "../../helpers/realtime";
import {
  matchCreateEnvelope,
  matchDataSendEnvelope,
  matchJoinEnvelope,
  matchLeaveEnvelope,
} from "../../helpers/match-world";
import { recordingMatch } from "../../helpers/match-service";
import { TENANT_A } from "../../helpers/tenants";

/**
 * M7 契约：`match_create` / `match_join` / `match_leave` / `match_data_send` 四条帧。
 *
 * 三条反直觉但必须复刻的行为（每一条都有上游源码依据）：
 *
 * 1. `match_data_send` 的 `Invalid match ID` 错误帧**没有 cid**——上游那一处没设 `Cid`；
 * 2. `match_data_send` 在"过滤器里有坏 uuid"与"发送者不是成员"两处**一个字节都不发**，
 *    直接关连接（上游 `return false, nil`）；
 * 3. `match_join` 的 token 分支解出 mid 之后**仍然**要求 `<uuid>.<node>` 的形状，
 *    形状不对报 `Invalid match token` 而不是 `Invalid match ID`。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_match.go::Pipeline.matchCreate
 * 契约源: server/pipeline_match.go::Pipeline.matchJoin
 * 契约源: server/pipeline_match.go::Pipeline.matchLeave
 * 契约源: server/pipeline_match.go::Pipeline.matchDataSend
 *
 * REQ-0001-018
 */

function context(match: ReturnType<typeof recordingMatch>) {
  return pipelineContext(TENANT_A, recordingStatus().service, { match: match.service });
}

const SAMPLE_ID = "123e4567-e89b-42d3-a456-426614174000.";

describe("M7 契约: match_create", () => {
  it("test_named_create_derives_a_v5_match_id", async () => {
    const match = recordingMatch();
    const result = await handleEnvelope(context(match), matchCreateEnvelope("c1", "my-room"));

    expect(match.creates).toHaveLength(1);
    const input = match.creates[0];
    // 同名同局：v5 派生是契约的一部分（客户端就是靠它重连回同一场）。
    expect(input?.matchId).toBe(`${await uuidV5(NAMESPACE_DNS, "my-room")}.`);
    expect(input?.named).toBe(true);
    expect(result.close).toBe(false);
  });

  it("test_unnamed_create_uses_a_random_v4", async () => {
    const first = recordingMatch();
    const second = recordingMatch();
    await handleEnvelope(context(first), matchCreateEnvelope("c1"));
    await handleEnvelope(context(second), matchCreateEnvelope("c1"));

    const one = first.creates[0]?.matchId ?? "";
    const two = second.creates[0]?.matchId ?? "";
    expect(one).toMatch(/^[0-9a-f-]{36}\.$/u);
    expect(two).toMatch(/^[0-9a-f-]{36}\.$/u);
    expect(one).not.toBe(two);
    expect(first.creates[0]?.named).toBe(false);
  });
});

describe("M7 契约: match_join", () => {
  it("test_invalid_match_id_is_bad_input", async () => {
    const match = recordingMatch();
    const result = await handleEnvelope(context(match), matchJoinEnvelope("c1", { matchId: "not-a-uuid." }));
    expect(errorOf(onlyReply(result))).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Invalid match ID",
    });
    expect(match.joins).toHaveLength(0);
  });

  it("test_missing_id_and_token_is_its_own_message", async () => {
    const result = await handleEnvelope(
      context(recordingMatch()),
      matchJoinEnvelope("c1", {}),
    );
    expect(errorOf(onlyReply(result))).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "No match ID or token found",
    });
  });

  it("test_unresolvable_token_is_invalid_match_token", async () => {
    const match = recordingMatch();
    const result = await handleEnvelope(context(match), matchJoinEnvelope("c1", { token: "junk" }));
    expect(errorOf(onlyReply(result))).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Invalid match token",
    });
    expect(match.joins).toHaveLength(0);
    expect(match.tokens).toEqual(["junk"]);
  });

  it("test_token_that_resolves_to_a_malformed_mid_reports_the_token_message", async () => {
    const match = recordingMatch();
    match.tokenResult = "still-not-a-uuid.";
    const result = await handleEnvelope(context(match), matchJoinEnvelope("c1", { token: "t" }));
    // 注意：同一条文案，但理由不同（形状不对 vs 验签不过）。
    expect(errorOf(onlyReply(result))).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Invalid match token",
    });
  });

  it("test_token_join_allows_an_empty_match", async () => {
    const match = recordingMatch();
    match.tokenResult = SAMPLE_ID;
    await handleEnvelope(context(match), matchJoinEnvelope("c1", { token: "t" }, { mode: "relay" }));

    expect(match.joins[0]?.matchId).toBe(SAMPLE_ID);
    // token 分支 = "该新建一场中继对局"的指令。
    expect(match.joins[0]?.allowEmpty).toBe(true);
    expect(match.joins[0]?.metadata).toEqual({ mode: "relay" });
  });

  it("test_match_id_join_does_not_allow_empty", async () => {
    const match = recordingMatch();
    await handleEnvelope(context(match), matchJoinEnvelope("c1", { matchId: SAMPLE_ID }));
    expect(match.joins[0]?.allowEmpty).toBe(false);
  });

  it("test_not_found_and_rejected_have_distinct_codes", async () => {
    const missing = recordingMatch({ ok: false, failure: { kind: "not-found" } });
    const missingResult = await handleEnvelope(
      context(missing),
      matchJoinEnvelope("c1", { matchId: SAMPLE_ID }),
    );
    expect(errorOf(onlyReply(missingResult))).toEqual({
      code: Error_Code.MATCH_NOT_FOUND,
      message: "Match not found",
    });

    const emptyReason = recordingMatch({ ok: false, failure: { kind: "rejected", reason: "" } });
    expect(
      errorOf(onlyReply(await handleEnvelope(context(emptyReason), matchJoinEnvelope("c1", { matchId: SAMPLE_ID })))),
    ).toEqual({ code: Error_Code.MATCH_JOIN_REJECTED, message: "Match join rejected" });

    const withReason = recordingMatch({
      ok: false,
      failure: { kind: "rejected", reason: "match is full" },
    });
    expect(
      errorOf(
        onlyReply(await handleEnvelope(context(withReason), matchJoinEnvelope("c1", { matchId: SAMPLE_ID }))),
      ),
    ).toEqual({ code: Error_Code.MATCH_JOIN_REJECTED, message: "match is full" });
  });
});

describe("M7 契约: match_leave", () => {
  it("test_invalid_match_id_is_bad_input_with_cid", async () => {
    const match = recordingMatch();
    const result = await handleEnvelope(context(match), matchLeaveEnvelope("c1", "nope"));
    const reply = onlyReply(result);
    expect(reply.cid).toBe("c1");
    expect(errorOf(reply)).toEqual({ code: Error_Code.BAD_INPUT, message: "Invalid match ID" });
    expect(match.leaves).toHaveLength(0);
  });

  it("test_success_passes_the_id_through_and_keeps_the_socket", async () => {
    const match = recordingMatch();
    const result = await handleEnvelope(context(match), matchLeaveEnvelope("c1", SAMPLE_ID));
    expect(match.leaves[0]?.matchId).toBe(SAMPLE_ID);
    expect(result.close).toBe(false);
  });
});

describe("M7 契约: match_data_send", () => {
  it("test_invalid_match_id_error_frame_has_no_cid", async () => {
    const result = await handleEnvelope(
      context(recordingMatch()),
      matchDataSendEnvelope("c1", "nope", { opCode: 1n, data: new Uint8Array([1]) }),
    );
    const reply = onlyReply(result);
    // 上游那一处没有设 Cid —— 这不是笔误，是必须复刻的形状。
    expect(reply.cid).toBe("");
    expect(errorOf(reply)).toEqual({ code: Error_Code.BAD_INPUT, message: "Invalid match ID" });
    expect(result.close).toBe(true);
  });

  it("test_a_broken_filter_uuid_closes_silently", async () => {
    const result = await handleEnvelope(
      context(recordingMatch()),
      matchDataSendEnvelope("c1", SAMPLE_ID, {
        opCode: 1n,
        data: new Uint8Array(),
        presences: [{ userId: "not-a-uuid", sessionId: "1" }],
      }),
    );
    expect(result.replies).toHaveLength(0);
    expect(result.close).toBe(true);
  });

  it("test_a_sender_that_is_not_a_member_closes_silently", async () => {
    const match = recordingMatch({ ok: false, failure: { kind: "silent" } });
    const result = await handleEnvelope(
      context(match),
      matchDataSendEnvelope("c1", SAMPLE_ID, { opCode: 7n, data: new Uint8Array([9]) }),
    );
    expect(result.replies).toHaveLength(0);
    expect(result.close).toBe(true);
    expect(match.sends[0]?.opCode).toBe(7n);
  });

  it("test_filters_are_normalised_before_the_service_sees_them", async () => {
    const match = recordingMatch();
    // 客户端可以把 uuid 写成无连字符的小写形式；服务层看到的一定是规范大写标准形
    // （与本项目 `users.id` 的写法一致），过滤比对再统一降成小写。
    const raw = "123e4567e89b42d3a456426614174000";
    await handleEnvelope(
      context(match),
      matchDataSendEnvelope("c1", SAMPLE_ID, {
        opCode: 2n,
        data: new Uint8Array([1, 2, 3]),
        presences: [{ userId: raw, sessionId: raw }],
      }),
    );
    expect(match.sends[0]?.filters).toEqual([
      { userId: "123E4567-E89B-42D3-A456-426614174000", sessionId: "123E4567-E89B-42D3-A456-426614174000" },
    ]);
  });
});
