import { describe, expect, it } from "vitest";

import { deliveryBody, parseDelivery } from "../../../src/durable/delivery";
import { matchDataEnvelope, matchPresenceEventEnvelope } from "../../../src/realtime/match";
import { matchmakerMatchedEnvelope } from "../../../src/realtime/matchmaker";
import type { Envelope } from "../../../src/proto/realtime_pb";

/**
 * M7 契约：帧跨 DO 边界往返之后**字段不变**。
 *
 * 上游那三条 `TestEncode*` 用 gob 编解码 `[]MatchmakerEntry` / `[]Presence`，
 * 钉的是同一件事：运行时把这些结构交给别的组件时不会掉字段。本项目没有 gob，
 * 跨边界的地方是 DO → DO 的投递（`deliveryBody` / `parseDelivery`，protojson），
 * 于是等价物就是"编码再解码，逐字段相等"（ECN-0011 偏差 10）。
 *
 * 为什么值得单独测：protojson 有三个坑——`op_code` 是 int64（走字符串）、
 * `data` 是 bytes（走 base64）、`label` 是包装类型（空串也带键）。这三样任意一样
 * 往返之后走样，客户端都会看到"服务端发的东西不对"，但单元测试看不出来。
 *
 * 溯源: server/match_registry_test.go::TestEncode
 * 溯源: server/match_registry_test.go::TestEncodeDecode
 * 溯源: server/match_registry_test.go::TestEncodeDecodePresences
 *
 * 契约源（机器可读）：
 * 契约源: server/match_registry.go::LocalMatchRegistry.JoinAttempt
 *
 * REQ-0001-018
 */

/** 走一遍真实的投递编码：对象 → 文本 → 对象。 */
function roundTrip(envelope: Envelope): Envelope {
  const wire = deliveryBody("session-1", envelope);
  return parseDelivery(JSON.parse(wire) as unknown).envelope;
}

const PRESENCE = { userId: "user-1", sessionId: "session-1", username: "one", node: "muster" };
const PEER = { userId: "user-2", sessionId: "session-2", username: "two", node: "muster" };

describe("M7 契约: 帧跨边界往返", () => {
  it("test_a_data_frame_survives_the_round_trip_byte_for_byte", () => {
    // 故意放一个 0x80 以上的字节：base64 编解码写错时它最容易先崩。
    const data = new Uint8Array([0x00, 0x7f, 0x80, 0xff, 0x2a]);
    const envelope = matchDataEnvelope("match-1.muster", PRESENCE, 42n, data, false);

    const decoded = roundTrip(envelope);
    expect(decoded.cid).toBe("");
    expect(decoded.message.case).toBe("matchData");
    if (decoded.message.case !== "matchData") throw new Error("unreachable");
    expect(decoded.message.value.matchId).toBe("match-1.muster");
    expect(decoded.message.value.opCode).toBe(42n);
    expect([...decoded.message.value.data]).toEqual([...data]);
    expect(decoded.message.value.reliable).toBe(false);
    // 发送者那一份也原样保留（它是 `match_data` 里唯一的 presence）。
    expect(decoded.message.value.presence?.userId).toBe(PRESENCE.userId);
    expect(decoded.message.value.presence?.username).toBe(PRESENCE.username);
  });

  it("test_the_presences_of_a_presence_event_survive_the_round_trip", () => {
    const envelope = matchPresenceEventEnvelope(
      "match-1.muster",
      [PRESENCE],
      [PEER],
    );

    const decoded = roundTrip(envelope);
    expect(decoded.message.case).toBe("matchPresenceEvent");
    if (decoded.message.case !== "matchPresenceEvent") throw new Error("unreachable");
    expect(decoded.message.value.matchId).toBe("match-1.muster");
    expect(decoded.message.value.joins).toHaveLength(1);
    const join = decoded.message.value.joins[0];
    expect([join?.userId, join?.sessionId, join?.username]).toEqual([
      PRESENCE.userId,
      PRESENCE.sessionId,
      PRESENCE.username,
    ]);
    const leave = decoded.message.value.leaves[0];
    expect([leave?.userId, leave?.sessionId, leave?.username]).toEqual([
      PEER.userId,
      PEER.sessionId,
      PEER.username,
    ]);
  });

  it("test_matchmaker_entries_keep_their_properties_and_self_binding", () => {
    const one = {
      ...PRESENCE,
      partyId: "party-1",
      stringProperties: { mode: "authoritative", d1: "foo" },
      numericProperties: { skill: 60 },
    };
    const two = { ...PEER, partyId: "", stringProperties: { d1: "foo" }, numericProperties: {} };
    const envelope = matchmakerMatchedEnvelope(
      { kind: "matchId", value: "match-1.muster" },
      "ticket-1",
      [one, two],
      two,
    );

    const decoded = roundTrip(envelope);
    expect(decoded.message.case).toBe("matchmakerMatched");
    if (decoded.message.case !== "matchmakerMatched") throw new Error("unreachable");
    const value = decoded.message.value;
    expect(value.ticket).toBe("ticket-1");
    expect(value.id.case).toBe("matchId");
    expect(value.id.case === "matchId" ? value.id.value : "").toBe("match-1.muster");
    expect(value.users).toHaveLength(2);
    expect(value.users[0]?.stringProperties).toEqual(one.stringProperties);
    expect(value.users[0]?.numericProperties).toEqual({ skill: 60 });
    expect(value.users[0]?.partyId).toBe("party-1");
    expect(value.users[0]?.presence?.userId).toBe(one.userId);
    // `self` 是"这份帧发给谁"，与 `users` 是两件事。
    expect(value.self?.presence?.sessionId).toBe(two.sessionId);
  });

  it("test_the_token_branch_keeps_the_empty_node_mid", () => {
    const envelope = matchmakerMatchedEnvelope(
      { kind: "token", value: "header.payload.signature" },
      "ticket-2",
      [{ ...PRESENCE, partyId: "", stringProperties: {}, numericProperties: {} }],
      { ...PRESENCE, partyId: "", stringProperties: {}, numericProperties: {} },
    );

    const decoded = roundTrip(envelope);
    if (decoded.message.case !== "matchmakerMatched") throw new Error("unreachable");
    expect(decoded.message.value.id.case).toBe("token");
    expect(decoded.message.value.id.case === "token" ? decoded.message.value.id.value : "").toBe(
      "header.payload.signature",
    );
  });
});
