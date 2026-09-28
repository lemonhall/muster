import { describe, expect, it } from "vitest";

import { errorBody, type SocialAccount } from "../../helpers/social-world";
import {
  groupHistory,
  groupWorld,
  memberAction,
  mustCreateGroup,
} from "../../helpers/group-world";

/**
 * 升职与降职。这两条的角色区间**不一样**，而它们又共用同一个 `shiftMembershipState`，
 * 所以这里是"区间必须照抄上游"这件事的唯一防线：
 *
 *   - 升职：`state > 0 AND state > 调用者 AND state <= MEMBER(2)`
 *     → MEMBER→ADMIN、ADMIN→SUPERADMIN；superadmin 自己不在区间里（到头了），
 *       而 admin 提不动另一个 admin（`state > 调用者` 把它排除了）；
 *   - 降职：`state >= 调用者 AND state < MEMBER(2)`
 *     → 只能降 SUPERADMIN 与 ADMIN；降 MEMBER 是静默无事发生。
 *
 * 两者都不改 `edge_count`（计数数的是成员，升职降职都没改变"是不是成员"），
 * 也都只写群频道事件、不发通知。
 *
 * 唯一的不一致还是那句：`demote` 空 `userIds` 报 `User IDs must be set.`，
 * 而 `promote` 空 `userIds` 是 200 `{}`。照抄。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_group.go::PromoteGroupUsers
 * 契约源: server/core_group.go::DemoteGroupUsers
 *
 * REQ-0001-012
 */

describe("POST /v2/group/{groupId}/promote", () => {
  it("walks a member up to admin and an admin up to superadmin", async () => {
    const world = await groupWorld(2);
    const [owner, member] = world.accounts as [SocialAccount, SocialAccount];
    const group = await mustCreateGroup(owner, { name: "ladder", open: true });
    expect((await memberAction(owner, group.id, "add", [member.id])).status).toBe(200);

    expect((await memberAction(owner, group.id, "promote", [member.id])).status).toBe(200);
    expect((await world.groupEdge(group.id, member.id))?.state).toBe(1);
    expect((await memberAction(owner, group.id, "promote", [member.id])).status).toBe(200);
    expect((await world.groupEdge(group.id, member.id))?.state).toBe(0);

    // 两次升职都只写频道事件：计数不变、没有通知。
    expect((await world.group(group.id))?.edge_count).toBe(2);
    // 唯一那条通知来自 `add`（`-4`），升职自己不发通知。
    expect((await world.notifications(member.id)).map((row) => row.code)).toEqual([-4]);
    const history = await groupHistory(owner, group.id);
    expect(history.body.messages?.filter((message) => message.code === 7)).toHaveLength(2);
  });

  it("does not promote a superadmin and lets an admin promote only members", async () => {
    const world = await groupWorld(3);
    const [owner, admin, member] = world.accounts as [SocialAccount, SocialAccount, SocialAccount];
    const group = await mustCreateGroup(owner, { name: "limits", open: true });
    expect((await memberAction(owner, group.id, "add", [admin.id, member.id])).status).toBe(200);
    expect((await memberAction(owner, group.id, "promote", [admin.id])).status).toBe(200);
    expect((await world.groupEdge(group.id, admin.id))?.state).toBe(1);

    // admin 提 member：可以。admin 提 admin：`state > 调用者` 把它排除了。
    expect((await memberAction(admin, group.id, "promote", [member.id])).status).toBe(200);
    expect((await world.groupEdge(group.id, member.id))?.state).toBe(1);
    expect((await memberAction(admin, group.id, "promote", [member.id])).status).toBe(200);
    expect((await world.groupEdge(group.id, member.id))?.state).toBe(1);

    // superadmin 已经到头：再次升职是静默无事发生（`state > 0` 这条把它排除了）。
    expect((await memberAction(owner, group.id, "promote", [owner.id])).status).toBe(200);
    expect((await world.groupEdge(group.id, owner.id))?.state).toBe(0);
  });

  it("requires manage rights and treats an empty id list as success", async () => {
    const world = await groupWorld(3);
    const [owner, member, outsider] = world.accounts as [
      SocialAccount,
      SocialAccount,
      SocialAccount,
    ];
    const group = await mustCreateGroup(owner, { name: "promote-guard", open: true });
    expect((await memberAction(owner, group.id, "add", [member.id])).status).toBe(200);

    const denied = await memberAction(member, group.id, "promote", [outsider.id]);
    expect(denied.status).toBe(404);
    expect((await errorBody(denied)).message).toBe("Group not found or permission denied.");

    const empty = await memberAction(owner, group.id, "promote", []);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({});
  });
});

describe("POST /v2/group/{groupId}/demote", () => {
  it("demotes an admin back to member without touching the member count", async () => {
    const world = await groupWorld(2);
    const [owner, member] = world.accounts as [SocialAccount, SocialAccount];
    const group = await mustCreateGroup(owner, { name: "demote", open: true });
    expect((await memberAction(owner, group.id, "add", [member.id])).status).toBe(200);
    expect((await memberAction(owner, group.id, "promote", [member.id])).status).toBe(200);
    expect((await world.groupEdge(group.id, member.id))?.state).toBe(1);

    expect((await memberAction(owner, group.id, "demote", [member.id])).status).toBe(200);
    expect((await world.groupEdge(group.id, member.id))?.state).toBe(2);
    expect((await world.group(group.id))?.edge_count).toBe(2);
    const history = await groupHistory(owner, group.id);
    expect(history.body.messages?.filter((message) => message.code === 9)).toHaveLength(1);
  });

  it("is a silent no-op for a member and can demote a second superadmin", async () => {
    const world = await groupWorld(2);
    const [owner, member] = world.accounts as [SocialAccount, SocialAccount];
    const group = await mustCreateGroup(owner, { name: "second-superadmin", open: true });
    expect((await memberAction(owner, group.id, "add", [member.id])).status).toBe(200);

    // MEMBER 不在降职区间里（`state < MEMBER`）。
    expect((await memberAction(owner, group.id, "demote", [member.id])).status).toBe(200);
    expect((await world.groupEdge(group.id, member.id))?.state).toBe(2);

    // 造出第二个 superadmin 再降掉他：守卫要求"还有别的 superadmin"，owner 就是那个别的。
    expect((await memberAction(owner, group.id, "promote", [member.id])).status).toBe(200);
    expect((await memberAction(owner, group.id, "promote", [member.id])).status).toBe(200);
    expect((await world.groupEdge(group.id, member.id))?.state).toBe(0);
    expect((await memberAction(owner, group.id, "demote", [member.id])).status).toBe(200);
    expect((await world.groupEdge(group.id, member.id))?.state).toBe(1);
  });

  it("rejects an empty id list (the one endpoint that does)", async () => {
    const world = await groupWorld(1);
    const [owner] = world.accounts as [SocialAccount];
    const group = await mustCreateGroup(owner, { name: "demote-empty" });

    const empty = await memberAction(owner, group.id, "demote", []);
    expect(empty.status).toBe(400);
    expect(await errorBody(empty)).toEqual({ code: 3, message: "User IDs must be set." });
  });
});
