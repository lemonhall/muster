import { afterEach, describe, expect, it } from "vitest";

import { errorOf } from "../../helpers/realtime";
import { expectNoNewFrame } from "../../helpers/realtime-socket";
import {
  partyCloseFrame,
  partyCreateFrame,
  partyJoinFrame,
  partyLeaveFrame,
  partyPromoteFrame,
  partyRemoveFrame,
} from "../../helpers/party-frames";
import {
  GUEST,
  OWNER,
  SPARE,
  ask,
  partyIdOf,
  partyWorld,
  waitForPresence,
  waitForKind,
  type PartyWorld,
} from "../../helpers/party-world";

// M8 派对状态机的"队长与退出"一半：提拔、踢人、主动关闭、离队继任。
//
// 与 lifecycle.test.ts 同源（真实 WebSocket → 分片 DO → 派对 DO），只是把
// "谁当家 / 谁走人"的路径单独放一个文件，免得单个测试文件越过 300 行。
//
// 契约源: server/party_handler.go::PartyHandler.Promote
// 契约源: server/party_handler.go::PartyHandler.Remove
// 契约源: server/party_handler.go::PartyHandler.Close
// 契约源: server/party_handler.go::PartyHandler.Leave
//
// REQ-0001-019

let world: PartyWorld | null = null;

afterEach(async () => {
  await world?.closeAll();
  world = null;
});

describe("M8 派对: 提拔 / 踢人 / 关闭 / 退出", () => {
  it("test_promote_moves_the_leadership_and_broadcasts_it", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const guest = await world.open("s2", GUEST);
    const { partyId } = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: true, maxSize: 4 })),
    );
    await ask(guest, partyJoinFrame("c2", partyId));

    const promoted = await ask(
      owner,
      partyPromoteFrame("c3", partyId, { userId: GUEST.id, sessionId: "s2", username: GUEST.username }),
    );
    // 上游先广播 `party_leader` 再回空信封，所以回执本身是空的。
    expect(promoted.message.case).toBeUndefined();
    const broadcast = await waitForKind(guest, "partyLeader");
    if (broadcast.message.case !== "partyLeader") throw new Error("期望 party_leader");
    expect(broadcast.message.value.presence?.sessionId).toBe("s2");

    // 队长已经换人：原队长再想踢人就是 `party leader only`。
    const failure = await ask(
      owner,
      partyRemoveFrame("c4", partyId, { userId: GUEST.id, sessionId: "s2", username: GUEST.username }),
    );
    expect(errorOf(failure).message).toBe(
      "Error removing party member or join request: party leader only",
    );
  });

  it("test_remove_kicks_a_member_and_sends_them_a_party_close", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const guest = await world.open("s2", GUEST);
    const spare = await world.open("s3", SPARE);
    const { partyId } = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: true, maxSize: 4 })),
    );
    await ask(guest, partyJoinFrame("c2", partyId));
    await ask(spare, partyJoinFrame("c3", partyId));

    await ask(
      owner,
      partyRemoveFrame("c4", partyId, { userId: GUEST.id, sessionId: "s2", username: GUEST.username }),
    );
    const kicked = await waitForKind(guest, "partyClose");
    if (kicked.message.case !== "partyClose") throw new Error("期望 party_close");
    expect(kicked.message.value.partyId).toBe(partyId);

    // 剩下的人收到一条 leave 事件。
    const event = await waitForPresence(spare, { leaves: ["s2"] });
    if (event.message.case !== "partyPresenceEvent") throw new Error("期望 presence 事件");
    expect(event.message.value.leaves.map((one) => one.sessionId)).toEqual(["s2"]);
  });

  it("test_leader_cannot_remove_themselves", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const { partyId } = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: true, maxSize: 4 })),
    );
    const failure = await ask(
      owner,
      partyRemoveFrame("c2", partyId, {
        userId: OWNER.id,
        sessionId: "s1",
        username: OWNER.username,
      }),
    );
    expect(errorOf(failure).message).toBe(
      "Error removing party member or join request: party cannot remove self",
    );
  });

  it("test_the_oldest_member_takes_over_when_the_leader_leaves", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const guest = await world.open("s2", GUEST);
    const { partyId } = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: true, maxSize: 4 })),
    );
    await ask(guest, partyJoinFrame("c2", partyId));

    await ask(owner, partyLeaveFrame("c3", partyId));
    const handover = await waitForKind(guest, "partyLeader");
    if (handover.message.case !== "partyLeader") throw new Error("期望 party_leader");
    expect(handover.message.value.presence?.sessionId).toBe("s2");
  });

  it("test_the_last_member_leaving_destroys_the_party_without_a_close", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const { partyId, uuid } = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: true, maxSize: 4 })),
    );

    await ask(owner, partyLeaveFrame("c2", partyId));
    // 上游 `stop()` 不发 `party_close`：一个不剩的派对是静默消失的。
    await expectNoNewFrame(owner, (frame) => frame.message.case === "partyClose");
    expect(await partyExists(world, uuid)).toBe(false);
  });

  it("test_close_broadcasts_party_close_to_everyone_and_removes_the_party", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const guest = await world.open("s2", GUEST);
    const { partyId, uuid } = partyIdOf(
      await ask(owner, partyCreateFrame("c1", { open: true, maxSize: 4 })),
    );
    await ask(guest, partyJoinFrame("c2", partyId));

    const reply = await ask(owner, partyCloseFrame("c3", partyId));
    // 回执是带 cid 的空信封；`party_close` 走广播（无 cid），队长那一份也在里面。
    expect(reply.message.case).toBeUndefined();
    const ownClose = await waitForKind(owner, "partyClose");
    if (ownClose.message.case !== "partyClose") throw new Error("期望 party_close");
    expect(ownClose.message.value.partyId).toBe(partyId);
    const broadcast = await waitForKind(guest, "partyClose");
    if (broadcast.message.case !== "partyClose") throw new Error("期望 party_close");
    expect(broadcast.message.value.partyId).toBe(partyId);
    expect(await partyExists(world, uuid)).toBe(false);
  });

  it("test_a_party_id_for_another_node_is_not_found", async () => {
    world = await partyWorld();
    const owner = await world.open("s1", OWNER);
    const failure = await ask(owner, partyJoinFrame("c1", `${crypto.randomUUID()}.别的节点`));
    expect(errorOf(failure).message).toBe("Error joining party: party not found");
  });
});

// 直接问派对 DO"你还在不在"（踢人/退出之后用来决定要不要清会话清单）。
async function partyExists(target: PartyWorld, uuid: string): Promise<boolean> {
  const response = await target.party(uuid).fetch("https://do/exists", { method: "POST" });
  return ((await response.json()) as { exists: boolean }).exists;
}
