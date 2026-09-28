import { afterEach, describe, expect, it } from "vitest";

import {
  partyCloseFrame,
  partyCreateFrame,
  partyDataSendFrame,
  partyJoinFrame,
  partyJoinRequestListFrame,
  partyAcceptFrame,
  partyRemoveFrame,
} from "../helpers/party-frames";
import { call } from "./http-helpers";
import {
  ask,
  closeSockets,
  expectNoNewFrame,
  partyIdOf,
  partyPlayer,
  sessionsOf,
  waitForKind,
  waitForNewKind,
  waitForPresence,
} from "./party-helpers";

/**
 * M8 E2E：派对 + 运行时 RPC，走真实 `wrangler dev --local` 进程上的真 WebSocket + 真 HTTP。
 *
 * 与 `tests/integration/party/` 的分工：那边直接拿 DO stub，验的是派对语义（谁在场、
 * 谁收得到、继任挑的是谁）；这里两端都是网络上的真连接，验的是**整条链在真实进程里
 * 成立**——创建 → 加入请求 → 批准 → 数据广播 → 踢人 → 关闭，以及目录面的 REST 形状。
 *
 * 目标进程是本机 workerd（见 `global-setup.ts`），不连任何 Cloudflare 账号资源。
 *
 * 时间预算：本地 dev 每个往返约 1.4s（M2 Review 记的），单条用例按分钟给预算。
 *
 * 契约源（机器可读）：
 * 契约源: server/party_handler.go::PartyHandler.JoinRequest
 * 契约源: server/api_party.go::ApiServer.ListParties
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/party
 *
 * REQ-0001-019
 */

afterEach(closeSockets);

/** 每个用例一个全新的标签区间：本地 D1 是跨运行保留的，靠它把这一轮的派对圈起来。 */
function freshRun(): { readonly label: string; readonly query: string } {
  const run = crypto.randomUUID().replace(/-/gu, "");
  return { label: `{"run":"${run}"}`, query: `label.run:${run}` };
}

describe("M8 E2E: 派对", () => {
  it("test_private_party_join_request_accept_broadcast_kick_close", { timeout: 240_000 }, async () => {
    const owner = await partyPlayer();
    const guest = await partyPlayer();
    const { label } = freshRun();

    const created = await ask(
      owner.socket,
      partyCreateFrame("c1", { open: false, maxSize: 4, label }),
    );
    const { partyId } = partyIdOf(created);
    if (created.message.case !== "party") throw new Error("期望 party 帧");
    const info = created.message.value;
    expect(partyId.endsWith(".muster")).toBe(true);
    expect(info.open).toBe(false);
    expect(info.hidden).toBe(false);
    expect(info.maxSize).toBe(4);
    // 回执里的标签是**客户端给的原文**（库里存的是规整后的那份）。
    expect(info.label).toBe(label);
    // 会话 id 由服务端分配，所以这里先记下来，后面的断言都对着它比。
    const ownerSession = info.self?.sessionId ?? "";
    expect(ownerSession).not.toBe("");
    expect(info.leader?.sessionId).toBe(ownerSession);
    expect(sessionsOf(info.presences)).toEqual([ownerSession]);

    // 私有派对的加入是**排队**：回执只有一条空信封，创始人收到一条请求通知。
    const queued = await ask(guest.socket, partyJoinFrame("c2", partyId));
    expect(queued.message.case).toBeUndefined();
    const notice = await waitForKind(owner.socket, "partyJoinRequest");
    if (notice.message.case !== "partyJoinRequest") throw new Error("期望 party_join_request");
    const pending = notice.message.value.presences[0];
    expect(pending?.userId).toBe(guest.userId);
    const guestSession = pending?.sessionId ?? "";
    expect(guestSession).not.toBe("");
    // 待批的人还没进流，所以拿不到 `party` 帧。
    await expectNoNewFrame(guest.socket, (frame) => frame.message.case === "party");

    // 队长可以把待批名单拉出来看（上游 `party_join_request_list`），名单里就是同一批人。
    // 回帧与"有人请求加入"用的是同一种：`party_join_request`（带 presences），而且
    // **不带 cid**，所以只能等"新来的那一帧"，不能按 cid 找。
    owner.socket.send(partyJoinRequestListFrame("c3", partyId));
    const listed = await waitForNewKind(owner.socket, "partyJoinRequest");
    if (listed.message.case !== "partyJoinRequest") throw new Error("期望待批名单");
    expect(sessionsOf(listed.message.value.presences)).toEqual([guestSession]);

    await ask(
      owner.socket,
      partyAcceptFrame("c4", partyId, {
        userId: guest.userId,
        sessionId: guestSession,
        username: guest.username,
      }),
    );
    const admitted = await waitForKind(guest.socket, "party");
    if (admitted.message.case !== "party") throw new Error("期望 party 帧");
    expect(admitted.message.value.self?.sessionId).toBe(guestSession);
    expect(sessionsOf(admitted.message.value.presences)).toEqual([ownerSession, guestSession]);
    const joined = await waitForPresence(owner.socket, { joins: [guestSession] });
    if (joined.message.case !== "partyPresenceEvent") throw new Error("期望 presence 事件");

    // 数据广播：到达别人的连接，不回显发送者。
    await ask(owner.socket, partyDataSendFrame("c5", partyId, 42n, new Uint8Array([9, 8, 7])));
    const data = await waitForKind(guest.socket, "partyData");
    if (data.message.case !== "partyData") throw new Error("期望 party_data");
    expect(data.cid).toBe("");
    expect(data.message.value.opCode).toBe(42n);
    expect(Array.from(data.message.value.data)).toEqual([9, 8, 7]);
    expect(data.message.value.presence?.sessionId).toBe(ownerSession);
    await expectNoNewFrame(owner.socket, (frame) => frame.message.case === "partyData");

    // 踢人：被踢的人收到 `party_close`，剩下的人收到一条 leave 事件。
    await ask(
      owner.socket,
      partyRemoveFrame("c6", partyId, {
        userId: guest.userId,
        sessionId: guestSession,
        username: guest.username,
      }),
    );
    const kicked = await waitForKind(guest.socket, "partyClose");
    if (kicked.message.case !== "partyClose") throw new Error("期望 party_close");
    expect(kicked.message.value.partyId).toBe(partyId);
    await waitForPresence(owner.socket, { leaves: [guestSession] });

    // 队长关闭：自己收到一条广播的 `party_close`（回执是带 cid 的空信封）。
    const closed = await ask(owner.socket, partyCloseFrame("c7", partyId));
    expect(closed.message.case).toBeUndefined();
    const ownClose = await waitForKind(owner.socket, "partyClose");
    if (ownClose.message.case !== "partyClose") throw new Error("期望 party_close");
    expect(ownClose.message.value.partyId).toBe(partyId);
  });

  it("test_the_directory_lists_open_parties_and_hides_hidden_ones", { timeout: 240_000 }, async () => {
    const owner = await partyPlayer();
    const hermit = await partyPlayer();
    const { label, query } = freshRun();

    // 一个开放派对 + 一个隐藏派对，标签相同；目录里只该出现开放的那一个。
    const visible = await ask(
      owner.socket,
      partyCreateFrame("c1", { open: true, maxSize: 8, label }),
    );
    const { partyId } = partyIdOf(visible);
    const invisible = await ask(
      hermit.socket,
      partyCreateFrame("c2", { open: true, hidden: true, maxSize: 2 }),
    );
    const hiddenId = partyIdOf(invisible).partyId;

    const listed = await call(
      `/v2/party?limit=100&open=true&query=${encodeURIComponent(query)}`,
      { token: owner.token },
    );
    expect(listed.status, `列出派对失败：${listed.status} ${await listed.clone().text()}`).toBe(200);
    const body = (await listed.json()) as {
      readonly parties?: readonly {
        readonly party_id: string;
        readonly open?: boolean;
        readonly max_size?: number;
        readonly label?: string;
      }[];
    };
    const entries = body.parties ?? [];
    expect(entries.map((entry) => entry.party_id)).toEqual([partyId]);
    expect(entries[0]?.open).toBe(true);
    expect(entries[0]?.max_size).toBe(8);
    expect(entries[0]?.label).toBe(label);
    expect(entries.some((entry) => entry.party_id === hiddenId)).toBe(false);
  });
});
