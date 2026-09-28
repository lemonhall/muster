import { afterEach, describe, expect, it } from "vitest";

import { errorBody, type SocialAccount } from "../../helpers/social-world";
import { bearer, call } from "../../helpers/tenants";
import {
  groupChannelIdOf,
  groupWorld,
  joinGroupRequest,
  memberAction,
  mustCreateGroup,
} from "../../helpers/group-world";
import { closeAllWorlds, sessionId } from "../../helpers/channel-world";
import { channelJoinEnvelope } from "../../helpers/channel";
import { openSocket, sendFrame, waitForFrame } from "../../helpers/realtime-socket";

/**
 * 群组频道的**准入**：`canAccessGroup` 与它的调用点（`pipeline_channel.go`）。
 *
 * v1 里这条路恒定拒绝（群组数据模型还没落地），M5 换成真查询之后第一件要钉住的事
 * 就是"谁能进、谁不能进"：SUPERADMIN / ADMIN / MEMBER 能进，**加入申请(3) 与
 * 被封禁(4) 都不能**——后者尤其容易漏，因为他们在 `group_edge` 里**确实有行**。
 *
 * 拒绝时上游回的是 `Group not found: Invalid channel target`（`BAD_INPUT`）：
 * "这个群不存在"与"你不是它的成员"刻意合成同一句，别把它拆开。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_channel.go::BuildChannelId
 * 契约源: server/core_group.go::groupCheckUserPermission
 *
 * REQ-0001-010
 */

afterEach(closeAllWorlds);

/** 开一条 socket 并加入群频道；返回收到的第一条该 cid 的帧。 */
async function joinGroupChannel(
  world: { readonly tenant: string },
  account: SocialAccount,
  groupId: string,
  cid: string,
): Promise<{ readonly ok: boolean; readonly message: string }> {
  const socket = await openSocket(world.tenant, sessionId(cid), account.id, account.username, {
    wantsStatus: false,
  });
  sendFrame(socket, channelJoinEnvelope(cid, groupId, 3));
  const frame = await waitForFrame(socket, (candidate) => candidate.cid === cid);
  if (frame.message.case === "error") {
    return { ok: false, message: frame.message.value.message };
  }
  return { ok: true, message: "" };
}

describe("群组频道准入", () => {
  it("admits members and rejects everybody else", async () => {
    const world = await groupWorld(4);
    const [owner, member, applicant, stranger] = world.accounts as [
      SocialAccount,
      SocialAccount,
      SocialAccount,
      SocialAccount,
    ];
    const group = await mustCreateGroup(owner, { name: "channel-access", open: true });
    expect((await joinGroupRequest(member, group.id)).status).toBe(200);
    // 申请人：先在私有群留下 state=3 的边，再被拒之门外。
    expect(
      (
        await call(`/v2/group/${group.id}`, {
          method: "PUT",
          authorization: bearer(owner.token),
          body: { open: false },
        })
      ).status,
    ).toBe(200);
    expect((await joinGroupRequest(applicant, group.id)).status).toBe(200);

    expect(await joinGroupChannel(world, owner, group.id, "c-owner")).toEqual({
      ok: true,
      message: "",
    });
    expect(await joinGroupChannel(world, member, group.id, "c-member")).toEqual({
      ok: true,
      message: "",
    });

    const denied = "Group not found: Invalid channel target";
    expect(await joinGroupChannel(world, applicant, group.id, "c-applicant")).toEqual({
      ok: false,
      message: denied,
    });
    expect(await joinGroupChannel(world, stranger, group.id, "c-stranger")).toEqual({
      ok: false,
      message: denied,
    });
  });

  it("rejects a member who was banned from the group channel", async () => {
    const world = await groupWorld(2);
    const [owner, member] = world.accounts as [SocialAccount, SocialAccount];
    const group = await mustCreateGroup(owner, { name: "channel-ban", open: true });
    expect((await joinGroupRequest(member, group.id)).status).toBe(200);
    expect(await joinGroupChannel(world, member, group.id, "c-before")).toEqual({
      ok: true,
      message: "",
    });

    expect((await memberAction(owner, group.id, "ban", [member.id])).status).toBe(200);
    expect(await joinGroupChannel(world, member, group.id, "c-after")).toEqual({
      ok: false,
      message: "Group not found: Invalid channel target",
    });
  });

  it("rejects an unknown group and a malformed target", async () => {
    const world = await groupWorld(1);
    const [owner] = world.accounts as [SocialAccount];

    expect(
      await joinGroupChannel(world, owner, "11111111-2222-4333-8444-555555555555", "c-missing"),
    ).toEqual({ ok: false, message: "Group not found: Invalid channel target" });

    const socket = await openSocket(world.tenant, sessionId("c-bad"), owner.id, owner.username, {
      wantsStatus: false,
    });
    sendFrame(socket, channelJoinEnvelope("c-bad", "not-a-uuid", 3));
    const frame = await waitForFrame(socket, (candidate) => candidate.cid === "c-bad");
    expect(frame.message.case).toBe("error");
  });

  it("keeps the REST history endpoint and the channel in agreement", async () => {
    const world = await groupWorld(2);
    const [owner, member] = world.accounts as [SocialAccount, SocialAccount];
    const group = await mustCreateGroup(owner, { name: "channel-rest", open: true });
    expect((await joinGroupRequest(member, group.id)).status).toBe(200);

    const history = await call(`/v2/channel/${groupChannelIdOf(group.id)}`, {
      authorization: bearer(member.token),
    });
    expect(history.status).toBe(200);

    // 非成员读历史同样是 `Group not found.`——REST 那一侧的话术与实时那侧不同。
    const stranger = await world.newAccount();
    const denied = await call(`/v2/channel/${groupChannelIdOf(group.id)}`, {
      authorization: bearer(stranger.token),
    });
    expect(denied.status).toBe(400);
    expect(await errorBody(denied)).toEqual({ code: 3, message: "Group not found." });
  });
});
