import { describe, expect, it } from "vitest";

import { errorBody, type SocialAccount } from "../../helpers/social-world";
import {
  groupHistory,
  groupWorld,
  joinGroupRequest,
  memberAction,
  mustCreateGroup,
} from "../../helpers/group-world";

/**
 * 群成员管理里"加人 / 踢人 / 封禁"三条。
 *
 * 三条都遵守同一个三段式（改库 → 维护计数 → 写事件），这里逐条钉住顺序的**可观测部分**：
 *
 *   - **加人**给目标发 `-4` 通知（`You've been added to group <name>`），并且
 *     "目标本来就申请过"时是**接受申请**（`3 → 2` 且计数 +1），不是再插一条边；
 *   - **踢人**只删边、不写封禁边，所以被踢的人还能再加入；
 *   - **封禁**删边之后补的那一行是**单行**（`source = 群`），所以被封禁的人
 *     自己的群列表里看不到这个群，而群成员列表按 `state=4` 过滤时看得到。
 *
 * 权限边界用的是上游那两条 DELETE：admin 只能动 `state > 1` 的边，superadmin 能动人，
 * 但谁都删不掉"最后一个 superadmin"。这里用"admin 踢 admin 是静默无事发生"来钉住前半句。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_group.go::AddGroupUsers
 * 契约源: server/core_group.go::KickGroupUsers
 * 契约源: server/core_group.go::BanGroupUsers
 *
 * REQ-0001-012
 */

/** 把某人提成 admin（`2 → 1`）：superadmin 的升职区间是 `state <= MEMBER`。 */
async function makeAdmin(owner: SocialAccount, groupId: string, userId: string): Promise<void> {
  const promoted = await memberAction(owner, groupId, "promote", [userId]);
  expect(promoted.status).toBe(200);
}

describe("POST /v2/group/{groupId}/add", () => {
  it("adds a user as a member, notifies them and announces it in the group channel", async () => {
    const world = await groupWorld(2);
    const [owner, target] = world.accounts as [SocialAccount, SocialAccount];
    const group = await mustCreateGroup(owner, { name: "crew", open: true });

    const response = await memberAction(owner, group.id, "add", [target.id]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});

    expect((await world.group(group.id))?.edge_count).toBe(2);
    expect((await world.groupEdge(group.id, target.id))?.state).toBe(2);

    const notifications = await world.notifications(target.id);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.code).toBe(-4);
    expect(notifications[0]?.subject).toBe("You've been added to group crew");
    expect(JSON.parse(notifications[0]?.content ?? "{}")).toEqual({
      group_id: group.id,
      name: "crew",
    });
    expect(notifications[0]?.sender_id).toBe(owner.id);

    const history = await groupHistory(owner, group.id);
    const added = history.body.messages?.find((message) => message.code === 4);
    expect(added?.username).toBe(target.username);
    expect(added?.sender_id).toBe(target.id);
  });

  it("accepts a pending join request instead of writing a second edge", async () => {
    const world = await groupWorld(2);
    const [owner, applicant] = world.accounts as [SocialAccount, SocialAccount];
    const group = await mustCreateGroup(owner, { name: "approval" });
    expect((await joinGroupRequest(applicant, group.id)).status).toBe(200);
    expect((await world.groupEdge(group.id, applicant.id))?.state).toBe(3);

    expect((await memberAction(owner, group.id, "add", [applicant.id])).status).toBe(200);
    expect((await world.groupEdge(group.id, applicant.id))?.state).toBe(2);
    // 申请被接受才算成员：计数从 1 变 2，通知也才发出（`-5` 那条是给管理员的）。
    expect((await world.group(group.id))?.edge_count).toBe(2);
    expect((await world.notifications(applicant.id)).map((row) => row.code)).toEqual([-4]);
  });

  it("is a silent no-op for an existing member and for the caller himself", async () => {
    const world = await groupWorld(2);
    const [owner, target] = world.accounts as [SocialAccount, SocialAccount];
    const group = await mustCreateGroup(owner, { name: "twice-add", open: true });
    expect((await memberAction(owner, group.id, "add", [target.id])).status).toBe(200);

    const again = await memberAction(owner, group.id, "add", [target.id]);
    expect(again.status).toBe(200);
    expect((await world.group(group.id))?.edge_count).toBe(2);
    expect(await world.notifications(target.id)).toHaveLength(1);

    // 调用者自己会被剔除：upstream 的 `if uid == caller { continue }`。
    expect((await memberAction(owner, group.id, "add", [owner.id])).status).toBe(200);
    expect((await world.groupEdge(group.id, owner.id))?.state).toBe(0);
  });

  it("requires manage rights and validates the ids", async () => {
    const world = await groupWorld(3);
    const [owner, member] = world.accounts as [SocialAccount, SocialAccount, SocialAccount];
    const group = await mustCreateGroup(owner, { name: "guarded-add", open: true });
    expect((await joinGroupRequest(member, group.id)).status).toBe(200);

    const denied = await memberAction(member, group.id, "add", [owner.id]);
    expect(denied.status).toBe(404);
    expect(await errorBody(denied)).toEqual({
      code: 5,
      message: "Group not found or permission denied.",
    });

    const unknown = await memberAction(owner, group.id, "add", [
      "11111111-2222-4333-8444-555555555555",
    ]);
    expect(unknown.status).toBe(400);
    expect((await errorBody(unknown)).message).toBe("One or more users not found.");

    const malformedUser = await memberAction(owner, group.id, "add", ["not-a-uuid"]);
    expect(malformedUser.status).toBe(400);
    expect((await errorBody(malformedUser)).message).toBe("User ID must be a valid ID.");

    const malformedGroup = await memberAction(owner, "not-a-uuid", "add", [member.id]);
    expect(malformedGroup.status).toBe(400);
    expect((await errorBody(malformedGroup)).message).toBe("Group ID must be a valid ID.");

    // 空 userIds 是成功的空操作（只有 demote 例外，见 roles 测试）。
    const empty = await memberAction(owner, group.id, "add", []);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({});
  });
});

describe("POST /v2/group/{groupId}/kick", () => {
  it("removes a member, records it in the group channel and leaves no ban edge", async () => {
    const world = await groupWorld(2);
    const [owner, member] = world.accounts as [SocialAccount, SocialAccount];
    const group = await mustCreateGroup(owner, { name: "doorman", open: true });
    expect((await joinGroupRequest(member, group.id)).status).toBe(200);

    expect((await memberAction(owner, group.id, "kick", [member.id])).status).toBe(200);
    expect(await world.groupEdge(group.id, member.id)).toBeNull();
    expect((await world.group(group.id))?.edge_count).toBe(1);

    const history = await groupHistory(owner, group.id);
    const kicked = history.body.messages?.find((message) => message.code === 6);
    expect(kicked?.username).toBe(member.username);

    // 被踢的人还能再加入：踢人**不写**封禁边。
    expect((await joinGroupRequest(member, group.id)).status).toBe(200);
    expect((await world.groupEdge(group.id, member.id))?.state).toBe(2);
  });

  it("lets an admin kick a member but not another admin", async () => {
    const world = await groupWorld(4);
    const [owner, first, second, third] = world.accounts as [
      SocialAccount,
      SocialAccount,
      SocialAccount,
      SocialAccount,
    ];
    const group = await mustCreateGroup(owner, { name: "ranks", open: true });
    expect(
      (await memberAction(owner, group.id, "add", [first.id, second.id, third.id])).status,
    ).toBe(200);
    await makeAdmin(owner, group.id, first.id);
    await makeAdmin(owner, group.id, second.id);
    expect((await world.groupEdge(group.id, first.id))?.state).toBe(1);

    // admin 踢 member：可以。
    expect((await memberAction(first, group.id, "kick", [third.id])).status).toBe(200);
    expect(await world.groupEdge(group.id, third.id)).toBeNull();
    expect((await world.group(group.id))?.edge_count).toBe(3);

    // admin 踢另一个 admin：静默无事发生（上游把权限边界写在 DELETE 的 WHERE 里）。
    const refused = await memberAction(first, group.id, "kick", [second.id]);
    expect(refused.status).toBe(200);
    expect((await world.groupEdge(group.id, second.id))?.state).toBe(1);
  });
});

describe("POST /v2/group/{groupId}/ban", () => {
  it("leaves a single banned edge and announces it", async () => {
    const world = await groupWorld(2);
    const [owner, member] = world.accounts as [SocialAccount, SocialAccount];
    const group = await mustCreateGroup(owner, { name: "blacklist", open: true });
    expect((await joinGroupRequest(member, group.id)).status).toBe(200);

    expect((await memberAction(owner, group.id, "ban", [member.id])).status).toBe(200);
    expect((await world.groupEdge(group.id, member.id))?.state).toBe(4);
    expect((await world.group(group.id))?.edge_count).toBe(1);

    // 单行边：群里只有 `group → user` 那一半，用户那一侧没有边，
    // 所以"我的群列表"里看不到这个群，而群成员列表按 state=4 看得到他。
    const edges = await world.groupEdges(group.id);
    expect(edges.map((edge) => edge.destination_id)).toEqual([owner.id, member.id]);
    expect(edges.filter((edge) => edge.state === 4)).toHaveLength(1);
    const mine = await world.as(member, `/v2/user/${member.id}/group`);
    expect(((await mine.json()) as { user_groups?: unknown[] }).user_groups ?? []).toHaveLength(0);

    const history = await groupHistory(owner, group.id);
    const banned = history.body.messages?.find((message) => message.code === 8);
    expect(banned?.username).toBe(member.username);
  });

  it("is a silent no-op for a non-member and for an unknown group", async () => {
    const world = await groupWorld(3);
    const [owner, outsider, other] = world.accounts as [
      SocialAccount,
      SocialAccount,
      SocialAccount,
    ];
    const group = await mustCreateGroup(owner, { name: "ban-outsider", open: true });

    // 目标不是成员：`deleteManagedMembership` 删到 0 行，于是**既不写封禁边**
    // 也不发通知（上游 `RETURNING` 拿不到行就直接 continue）。
    const notMember = await memberAction(owner, group.id, "ban", [outsider.id]);
    expect(notMember.status).toBe(200);
    expect(await world.groupEdge(group.id, outsider.id)).toBeNull();

    const missing = await memberAction(other, "11111111-2222-4333-8444-555555555555", "ban", [
      outsider.id,
    ]);
    expect(missing.status).toBe(404);
    expect((await errorBody(missing)).message).toBe("Group not found or permission denied.");
  });
});
