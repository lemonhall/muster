import { afterEach, describe, expect, it } from "vitest";

import { errorOf } from "../../helpers/realtime";
import { expectNoNewFrame } from "../../helpers/realtime-socket";
import {
  partyCreateFrame,
  partyDataSendFrame,
  partyJoinFrame,
  partyLeaveFrame,
  partyMatchmakerAddFrame,
  partyMatchmakerRemoveFrame,
  partyUpdateFrame,
} from "../../helpers/party-frames";
import {
  GUEST,
  OWNER,
  ask,
  partyIdOf,
  partyWorld,
  waitForKind,
  type PartyWorld,
} from "../../helpers/party-world";

// M8 派对的数据面与匹配票：`party_data_send` / `party_update` / `party_matchmaker_*`。
//
// 三条容易抄错的上游行为在这里钉住：
// 1. `data_send` **不回显发送者**（发送者不在收件人里）；
// 2. `update` 的"隐藏派对不许带非空标签"校验**先于**队长校验；
// 3. 成员变动一律撤掉这个派对的匹配票——包括我们自己主动撤票之后再有人进出。
//
// 溯源: server/party_handler_test.go::TestPartyMatchmakerAddAndRemove
//
// 契约源（机器可读）：
// 契约源: server/party_handler.go::PartyHandler.DataSend
// 契约源: server/party_handler.go::PartyHandler.Update
// 契约源: server/party_handler.go::PartyHandler.MatchmakerAdd
//
// REQ-0001-019

let world: PartyWorld | null = null;

afterEach(async () => {
  await world?.closeAll();
  world = null;
});

describe("M8 派对: 数据广播", () => {
  it("test_data_reaches_everyone_but_the_sender", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const guest = await world.open("s2", GUEST);
    const { partyId } = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: true, maxSize: 4 })),
    );
    await ask(guest, partyJoinFrame("c2", partyId));

    const payload = new Uint8Array([9, 8, 7]);
    const ack = await ask(owner, partyDataSendFrame("c3", partyId, 42n, payload));
    expect(ack.message.case).toBeUndefined();

    const received = await waitForKind(guest, "partyData");
    if (received.message.case !== "partyData") throw new Error("期望 party_data");
    expect(received.cid).toBe("");
    expect(received.message.value.opCode).toBe(42n);
    expect(Array.from(received.message.value.data)).toEqual([9, 8, 7]);
    expect(received.message.value.presence?.sessionId).toBe("s1");

    // 发送者自己不该收到这条（上游把发送者从收件人里排掉，只回一条空信封）。
    await expectNoNewFrame(owner, (frame) => frame.message.case === "partyData");
  });
});

describe("M8 派对: 标签与开放位更新", () => {
  it("test_update_broadcasts_the_new_listing_and_answers_the_leader", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const guest = await world.open("s2", GUEST);
    const { partyId } = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: true, maxSize: 4 })),
    );
    await ask(guest, partyJoinFrame("c2", partyId));

    const ack = await ask(
      owner,
      partyUpdateFrame("c3", partyId, { label: '{"mode":"duo"}', open: false, hidden: false }),
    );
    // 回执是带 cid 的空信封；`party_update` 走广播（含队长自己在内）。
    expect(ack.message.case).toBeUndefined();
    const frame = await waitForKind(guest, "partyUpdate");
    if (frame.message.case !== "partyUpdate") throw new Error("期望 party_update");
    expect(frame.cid).toBe("");
    expect(frame.message.value.partyId).toBe(partyId);
    expect(frame.message.value.label).toBe('{"mode":"duo"}');
    expect(frame.message.value.open).toBe(false);
    expect(frame.message.value.hidden).toBe(false);
  });

  it("test_a_non_empty_label_on_a_hidden_party_is_rejected_even_for_a_non_leader", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const guest = await world.open("s2", GUEST);
    const { partyId } = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: true, maxSize: 4 })),
    );
    await ask(guest, partyJoinFrame("c2", partyId));

    // 非队长 + 隐藏带标签：报的是标签那一条（顺序就是契约）。
    const failure = await ask(
      guest,
      partyUpdateFrame("c3", partyId, { label: "{\"a\":1}", hidden: true }),
    );
    expect(errorOf(failure).message).toBe(
      "Error updating party: party is hidden and label is not empty, invalid operation",
    );
  });

  it("test_a_non_empty_label_on_a_hidden_party_is_rejected_for_the_leader_too", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const { partyId } = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: true, maxSize: 4 })),
    );
    const leaderFailure = await ask(
      owner,
      partyUpdateFrame("c2", partyId, { label: "{\"a\":1}", hidden: true }),
    );
    expect(errorOf(leaderFailure).message).toBe(
      "Error updating party: party is hidden and label is not empty, invalid operation",
    );
  });

  it("test_a_hidden_party_accepts_an_empty_label", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const { partyId } = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: true, maxSize: 4 })),
    );
    // 隐藏 + 空标签是允许的。
    const ok = await ask(owner, partyUpdateFrame("c2", partyId, { label: "", hidden: true }));
    expect(ok.message.case).toBeUndefined();
  });
});

describe("M8 派对: 整队一张匹配票", () => {
  it("test_the_leader_can_put_the_whole_party_into_the_pool", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const guest = await world.open("s2", GUEST);
    const { partyId } = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: true, maxSize: 4 })),
    );
    await ask(guest, partyJoinFrame("c2", partyId));

    const reply = await ask(owner, partyMatchmakerAddFrame("c3", partyId, { minCount: 3, maxCount: 3 }));
    // 票号回给队长（带 cid）；其余成员拿到的是一条不带 cid 的同名帧。
    if (reply.message.case !== "partyMatchmakerTicket") throw new Error("期望 party_matchmaker_ticket");
    expect(reply.message.value.partyId).toBe(partyId);
    const ticket = reply.message.value.ticket;
    expect(ticket).not.toBe("");

    const mirrored = await waitForKind(guest, "partyMatchmakerTicket");
    if (mirrored.message.case !== "partyMatchmakerTicket") throw new Error("期望票号帧");
    expect(mirrored.cid).toBe("");
    expect(mirrored.message.value.ticket).toBe(ticket);

    // 票面归派对：池子里有一张票，且它的 party_id 是派对 id。
    expect(await ticketCount(world)).toBe(1);
    expect(await partyIdOfTicket(world, ticket)).toBe(partyId);

    // 队长可以自己撤票。
    await ask(owner, partyMatchmakerRemoveFrame("c4", partyId, ticket));
    expect(await ticketCount(world)).toBe(0);
  });

  it("test_a_member_change_invalidates_the_ticket", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const guest = await world.open("s2", GUEST);
    const { partyId } = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: true, maxSize: 4 })),
    );
    await ask(guest, partyJoinFrame("c2", partyId));
    await ask(owner, partyMatchmakerAddFrame("c3", partyId, { minCount: 3, maxCount: 3 }));
    expect(await ticketCount(world)).toBe(1);

    // 有人退出：队长手上的那张票必须作废（上游 `RemovePartyAll`）。
    await ask(guest, partyLeaveFrame("c4", partyId));
    expect(await ticketCount(world)).toBe(0);
  });

  it("test_only_the_leader_may_start_matchmaking", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const guest = await world.open("s2", GUEST);
    const { partyId } = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: true, maxSize: 4 })),
    );
    await ask(guest, partyJoinFrame("c2", partyId));

    const failure = await ask(guest, partyMatchmakerAddFrame("c3", partyId, { minCount: 3, maxCount: 3 }));
    expect(errorOf(failure).message).toBe("Error adding party to matchmaker: party leader only");
    expect(await ticketCount(world)).toBe(0);
  });

  it("test_removing_an_unknown_ticket_reports_the_matchmaker_wording", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const { partyId } = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: true, maxSize: 4 })),
    );
    const failure = await ask(owner, partyMatchmakerRemoveFrame("c2", partyId, "毫无关系"));
    expect(errorOf(failure).message).toBe("Error closing party: matchmaker ticket not found");
  });
});

async function stats(target: PartyWorld): Promise<Record<string, unknown>> {
  const response = await target.matchmaker().fetch("https://do/stats", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return (await response.json()) as Record<string, unknown>;
}

async function ticketCount(target: PartyWorld): Promise<number> {
  return Number((await stats(target))["ticketCount"] ?? 0);
}

/** 从匹配器池子里找出这张票的 `party_id`（票面归派对这件事必须被真的断言）。 */
async function partyIdOfTicket(target: PartyWorld, ticket: string): Promise<string | undefined> {
  const response = await target.matchmaker().fetch("https://do/tickets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { tickets?: readonly { ticket: string; partyId: string }[] };
  return body.tickets?.find((one) => one.ticket === ticket)?.partyId;
}
