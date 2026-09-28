import { describe, expect, it } from "vitest";

import { Error_Code } from "../../../src/realtime/errors";
import { handleEnvelope } from "../../../src/realtime/pipeline";
import { errorOf, onlyReply, pipelineContext, recordingStatus } from "../../helpers/realtime";
import { recordingParty } from "../../helpers/party";
import {
  partyAcceptFrame,
  partyCloseFrame,
  partyCreateFrame,
  partyDataSendFrame,
  partyJoinFrame,
  partyJoinRequestListFrame,
  partyLeaveFrame,
  partyMatchmakerAddFrame,
  partyMatchmakerRemoveFrame,
  partyPromoteFrame,
  partyRemoveFrame,
  partyUpdateFrame,
} from "../../helpers/party-frames";
import { TENANT_A } from "../../helpers/tenants";

// M8 契约：十一条 `party_*` 入站帧的**校验顺序与逐字文案**。
//
// 上游 `server/pipeline_party.go` 的顺序是契约：`promote`/`accept`/`remove` 先看
// presence 再看 id、`matchmaker_add` 的五条计数校验按固定次序、`matchmaker_remove`
// 先看空 ticket 再看 id。同一个坏请求落在两条校验之间时报哪一条，客户端看得见。
//
// 三条反直觉但必须复刻的上游行为也在这里钉住：
// 1. `party_create` 的判据是 `maxSize < 0 || > 256`（0 能过）；
// 2. `party_matchmaker_remove` 失败时用的是 `Error closing party:` 前缀；
// 3. 所有失败路径都是"发错误帧 + 关连接"。
//
// 契约源（机器可读）：
// 契约源: server/pipeline_party.go::Pipeline.partyCreate
// 契约源: server/pipeline_party.go::Pipeline.partyMatchmakerAdd
// 契约源: server/pipeline_party.go::Pipeline.partyMatchmakerRemove
//
// REQ-0001-019

const PARTY_ID = "11111111-1111-4111-8111-111111111111.muster";

function context(party: ReturnType<typeof recordingParty> = recordingParty()) {
  return pipelineContext(TENANT_A, recordingStatus().service, { party: party.service });
}

describe("M8 契约: party_create", () => {
  it("test_max_size_zero_is_accepted_but_negative_and_257_are_not", async () => {
    const party = recordingParty();
    const zero = await handleEnvelope(context(party), partyCreateFrame("c1", { maxSize: 0 }));
    expect(zero.close).toBe(false);
    expect(party.creates.map((one) => one.maxSize)).toEqual([0]);

    const negative = await handleEnvelope(context(party), partyCreateFrame("c2", { maxSize: -1 }));
    expect(errorOf(onlyReply(negative))).toEqual({
      code: Error_Code.BAD_INPUT,
      message: "Invalid party max size, must be 1-256",
    });
    expect(negative.close).toBe(true);

    const tooBig = await handleEnvelope(context(party), partyCreateFrame("c3", { maxSize: 257 }));
    expect(errorOf(onlyReply(tooBig)).message).toBe("Invalid party max size, must be 1-256");
  });

  it("test_a_service_failure_is_prefixed_with_creating_party", async () => {
    const party = recordingParty();
    party.failWith({ code: "party", reason: "label-too-long" });
    const result = await handleEnvelope(context(party), partyCreateFrame("c1", { maxSize: 4 }));
    expect(errorOf(onlyReply(result)).message).toBe("Error creating party: party label too long");
  });
});

describe("M8 契约: party_join / party_leave / party_close", () => {
  it("test_a_malformed_id_is_bad_input_before_any_service_call", async () => {
    const party = recordingParty();
    for (const bad of ["", "not-a-uuid", "11111111-1111-4111-8111-111111111111", "1.muster"]) {
      const result = await handleEnvelope(context(party), partyJoinFrame("c1", bad));
      expect(errorOf(onlyReply(result)).message).toBe("Invalid party ID");
      expect(result.close).toBe(true);
    }
    expect(party.joins).toHaveLength(0);
  });

  it("test_the_node_segment_is_handed_to_the_service", async () => {
    const party = recordingParty();
    await handleEnvelope(context(party), partyJoinFrame("c1", PARTY_ID));
    expect(party.joins[0]?.node).toBe("muster");
    expect(party.joins[0]?.partyId).toBe(PARTY_ID);
  });

  it("test_leave_and_close_validate_the_id_and_prefix_their_failures", async () => {
    const party = recordingParty();
    party.failWith({ code: "party", reason: "not-found" });
    const leave = await handleEnvelope(context(party), partyLeaveFrame("c1", PARTY_ID));
    expect(errorOf(onlyReply(leave)).message).toBe("Error leaving party: party not found");
    const close = await handleEnvelope(context(party), partyCloseFrame("c2", PARTY_ID));
    expect(errorOf(onlyReply(close)).message).toBe("Error closing party: party not found");
  });
});

describe("M8 契约: promote / accept / remove 先 presence 后 id", () => {
  it("test_an_incomplete_presence_is_reported_before_a_bad_id", async () => {
    const party = recordingParty();
    // presence 全空 + 坏 id：报的必须是 `Invalid presence`。
    const blank = { userId: "", sessionId: "", username: "" };
    const frames = [
      partyPromoteFrame("c1", "bad-id", blank),
      partyAcceptFrame("c1", "bad-id", blank),
      partyRemoveFrame("c1", "bad-id", blank),
    ];
    for (const frame of frames) {
      const result = await handleEnvelope(context(party), frame);
      expect(errorOf(onlyReply(result)).message).toBe("Invalid presence");
      expect(result.close).toBe(true);
    }
    expect(party.promotes).toHaveLength(0);
    expect(party.accepts).toHaveLength(0);
    expect(party.removes).toHaveLength(0);
  });

  it("test_a_valid_presence_with_a_bad_id_is_still_a_bad_input", async () => {
    const party = recordingParty();
    const good = { userId: "u", sessionId: "s", username: "name" };
    const promote = await handleEnvelope(context(party), partyPromoteFrame("c1", "bad-id", good));
    expect(errorOf(onlyReply(promote)).message).toBe("Invalid party ID");
  });
});

describe("M8 契约: party_matchmaker_add 的五条计数校验", () => {
  it("test_the_five_checks_run_in_the_upstream_order", async () => {
    const party = recordingParty();
    // 同时违反三条：报最先检查的那一条。
    const first = await handleEnvelope(
      context(party),
      partyMatchmakerAddFrame("c1", PARTY_ID, { minCount: 1, maxCount: 1, countMultiple: 0 }),
    );
    expect(errorOf(onlyReply(first)).message).toBe("Invalid minimum count, must be >= 2");

    const second = await handleEnvelope(
      context(party),
      partyMatchmakerAddFrame("c2", PARTY_ID, { minCount: 2, maxCount: 1, countMultiple: 0 }),
    );
    expect(errorOf(onlyReply(second)).message).toBe(
      "Invalid maximum count, must be >= minimum count",
    );

    const third = await handleEnvelope(
      context(party),
      partyMatchmakerAddFrame("c3", PARTY_ID, { minCount: 2, maxCount: 2, countMultiple: 0 }),
    );
    expect(errorOf(onlyReply(third)).message).toBe("Invalid count multiple, must be >= 1");

    const fourth = await handleEnvelope(
      context(party),
      partyMatchmakerAddFrame("c4", PARTY_ID, { minCount: 3, maxCount: 6, countMultiple: 2 }),
    );
    expect(errorOf(onlyReply(fourth)).message).toBe(
      "Invalid count multiple for minimum count, must divide",
    );

    const fifth = await handleEnvelope(
      context(party),
      partyMatchmakerAddFrame("c5", PARTY_ID, { minCount: 2, maxCount: 5, countMultiple: 2 }),
    );
    expect(errorOf(onlyReply(fifth)).message).toBe(
      "Invalid count multiple for maximum count, must divide",
    );
    expect(party.matchmakerAdds).toHaveLength(0);
  });

  it("test_an_empty_query_becomes_a_star_and_the_raw_id_is_passed_through", async () => {
    const party = recordingParty();
    const upper = "AAAAAAAA-1111-4111-8111-111111111111.Muster";
    await handleEnvelope(
      context(party),
      partyMatchmakerAddFrame("c1", upper, { minCount: 2, maxCount: 2, query: "" }),
    );
    expect(party.matchmakerAdds[0]?.query).toBe("*");
    // 回执与通知里的 `party_id` 用客户端原文，不是规整后的小写。
    expect(party.matchmakerAdds[0]?.rawPartyId).toBe(upper);
  });

  it("test_a_missing_count_multiple_defaults_to_one", async () => {
    const party = recordingParty();
    await handleEnvelope(context(party), partyMatchmakerAddFrame("c1", PARTY_ID, { minCount: 2, maxCount: 4 }));
    expect(party.matchmakerAdds[0]?.countMultiple).toBe(1);
  });

  it("test_the_matchmaker_wording_is_passed_through_unchanged", async () => {
    const party = recordingParty();
    party.failWith({ code: "text", message: "matchmaker query invalid" });
    const result = await handleEnvelope(context(party), partyMatchmakerAddFrame("c1", PARTY_ID));
    expect(errorOf(onlyReply(result)).message).toBe(
      "Error adding party to matchmaker: matchmaker query invalid",
    );
  });
});

describe("M8 契约: matchmaker_remove / data_send / update / join_request_list", () => {
  it("test_an_empty_ticket_is_reported_before_the_id_check", async () => {
    const party = recordingParty();
    const result = await handleEnvelope(context(party), partyMatchmakerRemoveFrame("c1", "bad-id", ""));
    expect(errorOf(onlyReply(result)).message).toBe("Invalid matchmaker ticket");
  });

  it("test_a_removal_failure_misuses_the_closing_prefix", async () => {
    const party = recordingParty();
    party.failWith({ code: "text", message: "matchmaker ticket not found" });
    const result = await handleEnvelope(context(party), partyMatchmakerRemoveFrame("c1", PARTY_ID, "t1"));
    expect(errorOf(onlyReply(result)).message).toBe(
      "Error closing party: matchmaker ticket not found",
    );
  });

  it("test_data_send_and_update_and_request_list_prefixes", async () => {
    const party = recordingParty();
    party.failWith({ code: "party", reason: "not-member" });
    const send = await handleEnvelope(
      context(party),
      partyDataSendFrame("c1", PARTY_ID, 7n, new Uint8Array([1, 2])),
    );
    expect(errorOf(onlyReply(send)).message).toBe("Error sending party data: party member not found");
    expect(party.dataSends[0]?.opCode).toBe(7n);

    const update = await handleEnvelope(context(party), partyUpdateFrame("c2", PARTY_ID));
    expect(errorOf(onlyReply(update)).message).toBe("Error updating party: party member not found");

    const list = await handleEnvelope(context(party), partyJoinRequestListFrame("c3", PARTY_ID));
    expect(errorOf(onlyReply(list)).message).toBe(
      "Error listing party join requests: party member not found",
    );
    expect(party.requestLists[0]?.rawPartyId).toBe(PARTY_ID);
  });
});
