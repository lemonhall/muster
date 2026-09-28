import { afterEach, describe, expect, it } from "vitest";

import { errorOf } from "../../helpers/realtime";
import { expectNoNewFrame } from "../../helpers/realtime-socket";
import {
  partyAcceptFrame,
  partyCreateFrame,
  partyJoinFrame,
} from "../../helpers/party-frames";
import {
  GUEST,
  OWNER,
  ask,
  partyIdOf,
  partyWorld,
  waitForPresence,
  waitForKind,
  type PartyWorld,
} from "../../helpers/party-world";

// M8 派对状态机：真实 WebSocket → 分片 DO → 派对 DO 的整条链路。
//
// 每条用例一个随机租户（于是每个派对 DO 都是全新的）。断言分成两类：
// **回执**（cid 相同的那一帧）与**广播**（无 cid，靠帧类型找）。
//
// 上游 `server/party_handler.go` 的状态机语义是契约：队长继任看"最老者"、
// 全员离开不发 `party_close`、队长主动关闭会给所有人发。这里逐条钉住。
//
// 溯源: server/party_handler_test.go::TestPartyMatchmakerAddAndRemove
//
// 契约源（机器可读）：
// 契约源: server/party_handler.go::PartyHandler.JoinRequest
// 契约源: server/party_handler.go::PartyHandler.Leave
// 契约源: server/party_handler.go::PartyHandler.Close
//
// REQ-0001-019

let world: PartyWorld | null = null;

afterEach(async () => {
  await world?.closeAll();
  world = null;
});

describe("M8 派对: 创建与开放加入", () => {
  it("test_create_answers_with_the_full_party_frame_and_a_presence_event", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);

    const reply = await ask(
      owner,
      partyCreateFrame("c1", { open: true, maxSize: 4, label: '{"mode":"raid"}' }),
    );
    const { partyId } = partyIdOf(reply);
    expect(partyId.endsWith(".muster")).toBe(true);
    if (reply.message.case !== "party") throw new Error("期望 party 帧");
    const info = reply.message.value;
    expect(info.open).toBe(true);
    expect(info.hidden).toBe(false);
    expect(info.maxSize).toBe(4);
    // 回执里的标签是**客户端给的原文**（库里存的是规整后的那份）。
    expect(info.label).toBe('{"mode":"raid"}');
    expect(info.self?.sessionId).toBe("s1");
    expect(info.leader?.sessionId).toBe("s1");
    expect(info.presences.map((one) => one.sessionId)).toEqual(["s1"]);

    // 创建者自己也收到一条"我加入了"的流事件（上游 tracker 的语义）。
    const event = await waitForKind(owner, "partyPresenceEvent");
    if (event.message.case !== "partyPresenceEvent") throw new Error("期望 presence 事件");
    expect(event.message.value.joins.map((one) => one.sessionId)).toEqual(["s1"]);
    expect(event.message.value.leaves).toEqual([]);
  });

  it("test_open_join_tracks_the_new_member_and_tells_everyone", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const guest = await world.open("s2", GUEST);
    const { partyId } = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: true, maxSize: 4 })),
    );

    await ask(guest, partyJoinFrame("c2", partyId));

    const guestInfo = await waitForKind(guest, "party");
    if (guestInfo.message.case !== "party") throw new Error("期望 party 帧");
    // 上游 `PartyHandler.Join` 那段没设 `hidden` 与 `label`，protojson 里就是零值。
    expect(guestInfo.cid).toBe("");
    expect(guestInfo.message.value.hidden).toBe(false);
    expect(guestInfo.message.value.label).toBe("");
    expect(guestInfo.message.value.self?.sessionId).toBe("s2");
    expect(guestInfo.message.value.leader?.sessionId).toBe("s1");
    expect(guestInfo.message.value.presences.map((one) => one.sessionId)).toEqual(["s1", "s2"]);

    const ownerEvent = await waitForPresence(owner, { joins: ["s2"] });
    if (ownerEvent.message.case !== "partyPresenceEvent") throw new Error("期望 presence 事件");
    expect(ownerEvent.message.value.joins.map((one) => one.sessionId)).toEqual(["s2"]);
  });
});

describe("M8 派对: 私有派对的加入请求", () => {
  it("test_private_join_queues_a_request_and_the_leader_is_notified", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const guest = await world.open("s2", GUEST);
    const { partyId } = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: false, maxSize: 4 })),
    );

    // 回执只有一条空信封——请求排队不是错误。
    const ack = await ask(guest, partyJoinFrame("c2", partyId));
    expect(ack.message.case).toBeUndefined();

    const notice = await waitForKind(owner, "partyJoinRequest");
    if (notice.message.case !== "partyJoinRequest") throw new Error("期望 party_join_request");
    expect(notice.message.value.presences.map((one) => one.sessionId)).toEqual(["s2"]);
    // 待批的人还没进流，所以拿不到 `party` 帧。
    await expectNoNewFrame(guest, (frame) => frame.message.case === "party");
  });

  it("test_duplicate_request_is_a_bad_input", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const guest = await world.open("s2", GUEST);
    const { partyId } = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: false, maxSize: 4 })),
    );
    await ask(guest, partyJoinFrame("c2", partyId));

    const failure = await ask(guest, partyJoinFrame("c3", partyId));
    expect(errorOf(failure)).toEqual({
      code: 3,
      message: "Error joining party: party join request duplicate",
    });
  });

  it("test_accept_admits_the_requester_and_broadcasts_the_join", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const guest = await world.open("s2", GUEST);
    const { partyId } = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: false, maxSize: 4 })),
    );
    await ask(guest, partyJoinFrame("c2", partyId));
    await waitForKind(owner, "partyJoinRequest");

    await ask(
      owner,
      partyAcceptFrame("c3", partyId, { userId: GUEST.id, sessionId: "s2", username: GUEST.username }),
    );

    const admitted = await waitForKind(guest, "party");
    if (admitted.message.case !== "party") throw new Error("期望 party 帧");
    expect(admitted.message.value.self?.sessionId).toBe("s2");
    expect(admitted.message.value.presences.map((one) => one.sessionId)).toEqual(["s1", "s2"]);

    const ownerEvent = await waitForPresence(owner, { joins: ["s2"] });
    if (ownerEvent.message.case !== "partyPresenceEvent") throw new Error("期望 presence 事件");
    expect(ownerEvent.message.value.joins.map((one) => one.sessionId)).toEqual(["s2"]);
  });
});
