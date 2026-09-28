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
 * 加入群组：开放群直接成为成员，私有群留下一条申请并通知管理员。
 *
 * 这条路径上有三个容易做成"看起来对"的错：
 *   1. **私有群的申请也写两行边**（`state = 3`），而且**不加** `edge_count`
 *      ——申请人不算成员；
 *   2. **通知的句子是给管理员的**：subject 是 `User <申请人> wants to join your group`，
 *      content 是 `{"group_id":...,"username":...}`，code = -5，sender 是申请人；
 *   3. **重复加入是成功的空操作**：不报错、不重复通知、不重复计数——被封禁的人
 *      再来也是这个结果（边已存在）。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_group.go::JoinGroup
 * 契约源: server/api_group.go::JoinGroup
 *
 * REQ-0001-012
 */

describe("POST /v2/group/{groupId}/join", () => {
  it("adds the caller as a member of an open group and announces it in the group channel", async () => {
    const world = await groupWorld(2);
    const [owner, joiner] = world.accounts as [SocialAccount, SocialAccount];
    const group = await mustCreateGroup(owner, { name: "open-doors", open: true });

    const response = await joinGroupRequest(joiner, group.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});

    expect((await world.group(group.id))?.edge_count).toBe(2);
    expect((await world.groupEdge(group.id, joiner.id))?.state).toBe(2);

    // 群频道里应当留下一条 code = 3（group_join）的系统消息，作者是加入的人。
    const history = await groupHistory(owner, group.id);
    expect(history.status).toBe(200);
    const join = history.body.messages?.find((message) => message.code === 3);
    expect(join?.sender_id).toBe(joiner.id);
    expect(join?.username).toBe(joiner.username);
    expect(join?.content ?? "{}").toBe("{}");
  });

  it("is a silent no-op when the caller is already a member", async () => {
    const world = await groupWorld(2);
    const [owner, joiner] = world.accounts as [SocialAccount, SocialAccount];
    const group = await mustCreateGroup(owner, { name: "twice", open: true });
    expect((await joinGroupRequest(joiner, group.id)).status).toBe(200);

    const again = await joinGroupRequest(joiner, group.id);
    expect(again.status).toBe(200);
    expect((await world.group(group.id))?.edge_count).toBe(2);
  });

  it("leaves a join request and notifies the admins when the group is closed", async () => {
    const world = await groupWorld(2);
    const [owner, applicant] = world.accounts as [SocialAccount, SocialAccount];
    const group = await mustCreateGroup(owner, { name: "closed-doors" });

    expect((await joinGroupRequest(applicant, group.id)).status).toBe(200);
    // 申请人不算成员：计数仍是 1，角色是 3（JOIN_REQUEST）。
    expect((await world.group(group.id))?.edge_count).toBe(1);
    expect((await world.groupEdge(group.id, applicant.id))?.state).toBe(3);

    const notifications = await world.notifications(owner.id);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.code).toBe(-5);
    expect(notifications[0]?.subject).toBe(`User ${applicant.username} wants to join your group`);
    expect(JSON.parse(notifications[0]?.content ?? "{}")).toEqual({
      group_id: group.id,
      username: applicant.username,
    });
    expect(notifications[0]?.sender_id).toBe(applicant.id);

    // 申请人还不是成员，所以读不了群频道（上游把"不是成员"与"群不存在"合成一句）。
    const history = await groupHistory(applicant, group.id);
    expect(history.status).toBe(400);
  });

  it("is a silent no-op when the caller was banned", async () => {
    const world = await groupWorld(2);
    const [owner, banned] = world.accounts as [SocialAccount, SocialAccount];
    const group = await mustCreateGroup(owner, { name: "no-entry", open: true });
    // 先把人加进来再封禁——"封禁一个不是成员的人"是静默无事发生（见 membership 套件）。
    expect((await joinGroupRequest(banned, group.id)).status).toBe(200);
    const ban = await memberAction(owner, group.id, "ban", [banned.id]);
    expect(ban.status).toBe(200);
    expect((await world.groupEdge(group.id, banned.id))?.state).toBe(4);

    expect((await joinGroupRequest(banned, group.id)).status).toBe(200);
    // 封禁边还在，计数也没变——"边已存在"就是上游的静默成功。
    expect((await world.groupEdge(group.id, banned.id))?.state).toBe(4);
    expect((await world.group(group.id))?.edge_count).toBe(1);
  });

  it("rejects an unknown group and a full group", async () => {
    const world = await groupWorld(2);
    const [owner, joiner] = world.accounts as [SocialAccount, SocialAccount];

    const missing = await joinGroupRequest(joiner, "11111111-2222-4333-8444-555555555555");
    expect(missing.status).toBe(404);
    expect(await errorBody(missing)).toEqual({ code: 5, message: "Group not found." });

    const full = await mustCreateGroup(owner, { name: "tiny", open: true, max_count: 1 });
    const rejected = await joinGroupRequest(joiner, full.id);
    expect(rejected.status).toBe(400);
    expect(await errorBody(rejected)).toEqual({ code: 3, message: "Group is full." });
    expect((await world.group(full.id))?.edge_count).toBe(1);
  });
});
