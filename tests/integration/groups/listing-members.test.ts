import { describe, expect, it } from "vitest";

import { errorBody, type SocialAccount } from "../../helpers/social-world";
import { bearer, call } from "../../helpers/tenants";
import {
  groupWorld,
  joinGroupRequest,
  memberAction,
  mustCreateGroup,
} from "../../helpers/group-world";

/**
 * 两条"按边读出来的列表"：群成员（`GET /v2/group/{id}/user`）与某人的群
 * （`GET /v2/user/{id}/group`）。
 *
 * 三条容易看漏的语义：
   - 群成员列表**默认不带 state 过滤时只到 state <= 3**：封禁边（4）被排除，
     而加入申请（3）**在**列表里（它确实是一条边）；
   - 游标带上 `state` 过滤时必须与过滤条件一致，否则 `Cursor is invalid.`；
   - `GET /v2/user/{userId}/group` 的 userId 非法时报的是 `Group ID must be a valid ID.`
     ——上游复制粘贴留下的文案，照抄。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_group.go::ListGroupUsers
 * 契约源: server/api_group.go::ListUserGroups
 *
 * REQ-0001-012
 */

interface GroupUserListResponse {
  readonly group_users?: readonly {
    readonly user: { readonly id: string; readonly username: string; readonly online?: boolean };
    readonly state: number;
  }[];
  readonly cursor?: string;
}

interface UserGroupListResponse {
  readonly user_groups?: readonly {
    readonly group: { readonly id: string; readonly name: string };
    readonly state: number;
  }[];
  readonly cursor?: string;
}

async function listMembers(
  account: SocialAccount,
  groupId: string,
  query = "",
): Promise<GroupUserListResponse> {
  const response = await call(`/v2/group/${groupId}/user${query}`, {
    authorization: bearer(account.token),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as GroupUserListResponse;
}

function rawListMembers(
  account: SocialAccount,
  groupId: string,
  query = "",
): Promise<Response> {
  return call(`/v2/group/${groupId}/user${query}`, { authorization: bearer(account.token) });
}

describe("GET /v2/group/{groupId}/user", () => {
  it("lists members, pending join requests and nobody who is banned", async () => {
    const world = await groupWorld(4);
    const [owner, member, applicant, banned] = world.accounts as [
      SocialAccount,
      SocialAccount,
      SocialAccount,
      SocialAccount,
    ];
    const group = await mustCreateGroup(owner, { name: "roster", open: true });
    expect((await memberAction(owner, group.id, "add", [member.id])).status).toBe(200);
    // 被封禁的人必须先是成员——"封禁一个不是成员的人"是静默无事发生（见 membership 套件）。
    expect((await joinGroupRequest(banned, group.id)).status).toBe(200);
    // 申请人在私有群的分支里才会留下申请边：先把群改成私有，再让他申请。
    const closed = await call(`/v2/group/${group.id}`, {
      method: "PUT",
      authorization: bearer(owner.token),
      body: { open: false },
    });
    expect(closed.status).toBe(200);
    expect((await joinGroupRequest(applicant, group.id)).status).toBe(200);
    expect((await memberAction(owner, group.id, "ban", [banned.id])).status).toBe(200);

    const all = await listMembers(owner, group.id);
    const states = (all.group_users ?? []).map((entry) => entry.state).sort();
    // owner(0) + member(2) + applicant(3)；被封禁的人没有成员边，不在列表里。
    expect(states).toEqual([0, 2, 3]);
    // `online` 只在真在线时出现（proto3 的 false 被省略），离线的人身上没有这个字段。
    expect(all.group_users?.[0]?.user.online).toBeUndefined();
    expect((all.group_users ?? []).map((entry) => entry.user.id)).not.toContain(banned.id);

    const membersOnly = await listMembers(owner, group.id, "?state=2");
    expect(membersOnly.group_users?.map((entry) => entry.user.id)).toEqual([member.id]);

    // state=4 才看得到被封禁的人（那条单行边是群那侧的 `destination`）。
    const bans = await listMembers(owner, group.id, "?state=4");
    expect(bans.group_users?.map((entry) => entry.user.id)).toEqual([banned.id]);
  });

  it("pages with a state-tagged cursor and rejects bad input", async () => {
    const world = await groupWorld(3);
    const [owner, first, second] = world.accounts as [SocialAccount, SocialAccount, SocialAccount];
    const group = await mustCreateGroup(owner, { name: "paged", open: true });
    expect((await memberAction(owner, group.id, "add", [first.id, second.id])).status).toBe(200);

    const page = await listMembers(owner, group.id, "?limit=1");
    expect(page.group_users).toHaveLength(1);
    expect(page.cursor).toBeDefined();
    const next = await listMembers(owner, group.id, `?limit=1&cursor=${encodeURIComponent(page.cursor ?? "")}`);
    expect(next.group_users).toHaveLength(1);
    expect(next.group_users?.[0]?.user.id).not.toBe(page.group_users?.[0]?.user.id);

    // 游标指向**下一页第一行**（state 2 的成员），所以 `state=0` 的过滤条件与它对不上。
    const mismatched = await rawListMembers(
      owner,
      group.id,
      `?state=0&cursor=${encodeURIComponent(page.cursor ?? "")}`,
    );
    expect(mismatched.status).toBe(400);
    expect((await errorBody(mismatched)).message).toBe("Cursor is invalid.");

    const badState = await rawListMembers(owner, group.id, "?state=5");
    expect(badState.status).toBe(400);
    expect((await errorBody(badState)).message).toBe(
      "Invalid state - state must be between 0 and 4.",
    );

    const badLimit = await rawListMembers(owner, group.id, "?limit=101");
    expect(badLimit.status).toBe(400);
    expect((await errorBody(badLimit)).message).toBe(
      "Invalid limit - limit must be between 1 and 100.",
    );
  });
});

describe("GET /v2/user/{userId}/group", () => {
  it("lists the groups a user belongs to and hides the ones he was banned from", async () => {
    const world = await groupWorld(3);
    const [owner, member, other] = world.accounts as [SocialAccount, SocialAccount, SocialAccount];
    const mine = await mustCreateGroup(owner, { name: "mine", open: true });
    const his = await mustCreateGroup(member, { name: "his", open: true });
    expect((await joinGroupRequest(owner, his.id)).status).toBe(200);
    const doomed = await mustCreateGroup(other, { name: "doomed", open: true });
    expect((await joinGroupRequest(owner, doomed.id)).status).toBe(200);
    expect((await memberAction(other, doomed.id, "ban", [owner.id])).status).toBe(200);

    const response = await call(`/v2/user/${owner.id}/group`, {
      authorization: bearer(owner.token),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as UserGroupListResponse;
    expect(body.user_groups?.map((entry) => entry.group.name).sort()).toEqual(["his", "mine"]);
    expect(body.user_groups?.map((entry) => entry.state).sort()).toEqual([0, 2]);
    expect(mine.id).toBeDefined();
  });

  it("rejects a malformed user id with the upstream's group-id wording", async () => {
    const world = await groupWorld(1);
    const [owner] = world.accounts as [SocialAccount];

    const malformed = await call("/v2/user/not-a-uuid/group", {
      authorization: bearer(owner.token),
    });
    expect(malformed.status).toBe(400);
    expect(await errorBody(malformed)).toEqual({
      code: 3,
      message: "Group ID must be a valid ID.",
    });
  });
});
