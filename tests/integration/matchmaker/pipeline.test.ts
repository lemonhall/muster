import { describe, expect, it } from "vitest";

import { Error_Code } from "../../../src/realtime/errors";
import { handleEnvelope } from "../../../src/realtime/pipeline";
import {
  errorOf,
  onlyReply,
  pipelineContext,
  recordingStatus,
  sole,
} from "../../helpers/realtime";
import {
  matchmakerAddEnvelope,
  matchmakerRemoveEnvelope,
} from "../../helpers/match-world";
import { recordingMatchmaker } from "../../helpers/match-service";
import { TENANT_A } from "../../helpers/tenants";

/**
 * M7 契约：`matchmaker_add` / `matchmaker_remove` 的校验顺序与逐字文案。
 *
 * 上游 `server/pipeline_matchmaker.go` 的五条计数校验是**顺序敏感**的：一张
 * `min_count=1` 且 `count_multiple=0` 的票，客户端被告知"最小人数错了"，
 * 因为上游先看这一条。这里按同样的顺序逐条钉住，外加"成功回票号"与
 * "撤票的两种失败分别是什么码"。
 *
 * 溯源: server/matchmaker_test.go::TestMatchmakerAddAndRemove
 * 溯源: server/matchmaker_test.go::TestMatchmakerAddRemoveRepeated
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_matchmaker.go::Pipeline.matchmakerAdd
 * 契约源: server/pipeline_matchmaker.go::Pipeline.matchmakerRemove
 *
 * REQ-0001-017
 */

function context(matchmaker: ReturnType<typeof recordingMatchmaker>) {
  return pipelineContext(TENANT_A, recordingStatus().service, { matchmaker: matchmaker.service });
}

describe("M7 契约: matchmaker_add 的五条校验（顺序即契约）", () => {
  it("test_min_count_below_two_is_reported_first", async () => {
    const matchmaker = recordingMatchmaker();
    // 这张票同时违反三条规则，但报出来的必须是最先检查的那一条。
    const result = await handleEnvelope(
      context(matchmaker),
      matchmakerAddEnvelope("c1", { minCount: 1, maxCount: 1, countMultiple: 0 }),
    );

    expect(errorOf(onlyReply(result))).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Invalid minimum count, must be >= 2",
    });
    expect(result.close).toBe(true);
    expect(matchmaker.adds).toHaveLength(0);
  });

  it("test_max_count_below_min_count", async () => {
    const result = await handleEnvelope(
      context(recordingMatchmaker()),
      matchmakerAddEnvelope("c1", { minCount: 4, maxCount: 2 }),
    );
    expect(errorOf(onlyReply(result))).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Invalid maximum count, must be >= minimum count",
    });
  });

  it("test_count_multiple_below_one", async () => {
    const result = await handleEnvelope(
      context(recordingMatchmaker()),
      matchmakerAddEnvelope("c1", { minCount: 2, maxCount: 4, countMultiple: 0 }),
    );
    expect(errorOf(onlyReply(result))).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Invalid count multiple, must be >= 1",
    });
  });

  it("test_count_multiple_must_divide_min_count_before_max_count", async () => {
    // 3 不能整除 4，也不能整除 6——两条规则都违反，先报"最小人数"那条。
    const result = await handleEnvelope(
      context(recordingMatchmaker()),
      matchmakerAddEnvelope("c1", { minCount: 4, maxCount: 6, countMultiple: 3 }),
    );
    expect(errorOf(onlyReply(result))).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Invalid count multiple for minimum count, must divide",
    });
  });

  it("test_count_multiple_must_divide_max_count", async () => {
    const result = await handleEnvelope(
      context(recordingMatchmaker()),
      matchmakerAddEnvelope("c1", { minCount: 6, maxCount: 7, countMultiple: 3 }),
    );
    expect(errorOf(onlyReply(result))).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Invalid count multiple for maximum count, must divide",
    });
  });
});

describe("M7 契约: matchmaker_add 的成功与宿主错误", () => {
  it("test_empty_query_is_rewritten_to_star_and_the_ticket_comes_back", async () => {
    const matchmaker = recordingMatchmaker();
    const result = await handleEnvelope(
      context(matchmaker),
      matchmakerAddEnvelope("c1", { minCount: 2, maxCount: 2, query: "" }),
    );

    const reply = onlyReply(result);
    expect(reply.message.case).toBe("matchmakerTicket");
    if (reply.message.case !== "matchmakerTicket") throw new Error("unreachable");
    expect(reply.message.value.ticket).toBe("t1");
    expect(reply.cid).toBe("c1");
    // 空查询串不是报错，而是"匹配一切"。
    expect(matchmaker.adds[0]?.query).toBe("*");
    expect(result.close).toBe(false);
  });

  it("test_missing_count_multiple_defaults_to_one", async () => {
    const matchmaker = recordingMatchmaker();
    await handleEnvelope(
      context(matchmaker),
      matchmakerAddEnvelope("c1", { minCount: 2, maxCount: 4 }),
    );
    expect(matchmaker.adds[0]?.countMultiple).toBe(1);
  });

  it("test_host_failure_becomes_runtime_exception", async () => {
    const matchmaker = recordingMatchmaker({ ok: false, failure: "too-many-tickets" });
    const result = await handleEnvelope(
      context(matchmaker),
      matchmakerAddEnvelope("c1", { minCount: 2, maxCount: 2 }),
    );
    expect(errorOf(onlyReply(result))).toEqual({
      code: Error_Code.RUNTIME_EXCEPTION,
      message: "Error adding to matchmaker",
    });
    expect(result.close).toBe(true);
  });
});

describe("M7 契约: matchmaker_remove", () => {
  it("test_empty_ticket_is_bad_input", async () => {
    const matchmaker = recordingMatchmaker();
    const result = await handleEnvelope(context(matchmaker), matchmakerRemoveEnvelope("c1", ""));
    expect(errorOf(onlyReply(result))).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Invalid matchmaker ticket",
    });
    expect(matchmaker.removes).toHaveLength(0);
  });

  it("test_missing_ticket_is_bad_input_but_other_failures_are_runtime", async () => {
    const missing = recordingMatchmaker(undefined, { ok: false, failure: "ticket-not-found" });
    const missingResult = await handleEnvelope(
      context(missing),
      matchmakerRemoveEnvelope("c1", "t1"),
    );
    expect(errorOf(onlyReply(missingResult))).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Matchmaker ticket not found",
    });

    const broken = recordingMatchmaker(undefined, { ok: false, failure: "not-available" });
    const brokenResult = await handleEnvelope(context(broken), matchmakerRemoveEnvelope("c2", "t2"));
    expect(errorOf(onlyReply(brokenResult))).toEqual({
      code: Error_Code.RUNTIME_EXCEPTION,
      message: "Error removing matchmaker ticket",
    });
  });

  it("test_success_replies_with_a_cid_only_envelope_and_keeps_the_socket", async () => {
    const matchmaker = recordingMatchmaker();
    const result = await handleEnvelope(context(matchmaker), matchmakerRemoveEnvelope("c9", "t1"));

    const reply = sole(result.replies);
    expect(reply.cid).toBe("c9");
    expect(reply.message.case).toBeUndefined();
    expect(result.close).toBe(false);
    expect(matchmaker.removes).toEqual([{ sessionId: "session-under-test", ticket: "t1" }]);
  });
});
