import { describe, expect, it } from "vitest";

import { errorBody, type SocialAccount } from "../../helpers/social-world";
import { bearer, call } from "../../helpers/tenants";
import {
  createGroupRequest,
  groupWorld,
  joinGroupRequest,
  memberAction,
  mustCreateGroup,
} from "../../helpers/group-world";

/**
 * 群组生命周期（建、改、删）的可观测契约。
 *
 * 每一条期望值都来自上游 `api_group.go` + `core_group.go`：错误文案逐字照抄，
 * 校验顺序（先 id、再字段、后权限）也照抄——因为"哪一条先报"是客户端能看到的。
 *
 * 三处容易写错、这里显式钉住的地方：
 *   - 建群的 `open` 是**普通 bool**（缺省 = false = 私有群），而群列表的 `open`
 *     是 BoolValue（"没给"和 "false" 是两件事）；
 *   - 建群后 `edge_count` 就是 1（创建者那条边已经算进去了）；
 *   - 建群写的是**两行** `SUPERADMIN(0)` 边（群→人、人→群）。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_group.go::CreateGroup
 * 契约源: server/api_group.go::UpdateGroup
 * 契约源: server/api_group.go::DeleteGroup
 * 契约源: server/core_group.go::CreateGroup
 *
 * REQ-0001-012
 */

function updateGroup(account: SocialAccount, groupId: string, body: unknown): Promise<Response> {
  return call(`/v2/group/${groupId}`, {
    method: "PUT",
    authorization: bearer(account.token),
    body,
  });
}

function deleteGroup(account: SocialAccount, groupId: string): Promise<Response> {
  return call(`/v2/group/${groupId}`, { method: "DELETE", authorization: bearer(account.token) });
}

describe("POST /v2/group", () => {
  it("creates an open group with a superadmin edge on both sides", async () => {
    const world = await groupWorld(1);
    const [owner] = world.accounts as [SocialAccount];
    const body = await mustCreateGroup(owner, { name: "raiders", open: true });

    expect(body.name).toBe("raiders");
    expect(body.creator_id).toBe(owner.id);
    expect(body.open).toBe(true);
    expect(body.edge_count).toBe(1);
    expect(body.max_count).toBe(100);
    expect(body.metadata).toBe("{}");
    // 空串字段按 protojson 规则整条省略。
    expect(body.description).toBeUndefined();
    expect(body.lang_tag).toBeUndefined();
    expect(body.create_time).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

    const row = await world.group(body.id);
    expect(row?.open).toBe(1);
    expect(row?.edge_count).toBe(1);
    expect(row?.max_count).toBe(100);

    const edges = await world.groupEdges(body.id);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.destination_id).toBe(owner.id);
    expect(edges[0]?.state).toBe(0);
    // 另一半（用户 → 群）也要在，否则"我加入了哪些群"就查不到。
    expect(await world.groupEdge(body.id, owner.id)).not.toBeNull();
    const mine = await call(`/v2/user/${owner.id}/group`, {
      authorization: bearer(owner.token),
    });
    expect(((await mine.json()) as { user_groups?: unknown[] }).user_groups).toHaveLength(1);
  });

  it("treats a missing open field as a closed group", async () => {
    const world = await groupWorld(1);
    const [owner] = world.accounts as [SocialAccount];
    const body = await mustCreateGroup(owner, { name: "secret" });
    expect(body.open).toBe(false);
    expect((await world.group(body.id))?.open).toBe(0);
  });

  it("rejects an empty name, a bad max count and a duplicate name", async () => {
    const world = await groupWorld(1);
    const [owner] = world.accounts as [SocialAccount];

    const noName = await createGroupRequest(owner, { name: "" });
    expect(noName.status).toBe(400);
    expect(await errorBody(noName)).toEqual({ code: 3, message: "Group name must be set." });

    const badMax = await createGroupRequest(owner, { name: "x", max_count: -1 });
    expect(badMax.status).toBe(400);
    expect((await errorBody(badMax)).message).toBe("Group max count must be >= 1 when set.");

    // max_count = 0 与缺省同义（上游只在 `mc != 0` 时才校验），不会报错。
    const zeroMax = await createGroupRequest(owner, { name: "zero", max_count: 0 });
    expect(zeroMax.status).toBe(200);
    expect(((await zeroMax.json()) as { max_count?: number }).max_count).toBe(100);

    await mustCreateGroup(owner, { name: "taken" });
    const duplicate = await createGroupRequest(owner, { name: "taken" });
    expect(duplicate.status).toBe(409);
    expect(await errorBody(duplicate)).toEqual({ code: 6, message: "Group name is in use." });
  });
});

describe("PUT /v2/group/{groupId}", () => {
  it("updates the editable fields and mirrors open into the boolean column", async () => {
    const world = await groupWorld(1);
    const [owner] = world.accounts as [SocialAccount];
    const group = await mustCreateGroup(owner, { name: "editable", open: true });

    const response = await updateGroup(owner, group.id, {
      name: "renamed",
      description: "desc",
      lang_tag: "en",
      avatar_url: "https://example.test/a.png",
      open: false,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});

    const row = await world.group(group.id);
    expect(row?.name).toBe("renamed");
    expect(row?.description).toBe("desc");
    expect(row?.lang_tag).toBe("en");
    expect(row?.avatar_url).toBe("https://example.test/a.png");
    expect(row?.open).toBe(0);
  });

  it("rejects empty strings, no fields, unchanged fields and a taken name", async () => {
    const world = await groupWorld(1);
    const [owner] = world.accounts as [SocialAccount];
    const group = await mustCreateGroup(owner, { name: "base" });
    await mustCreateGroup(owner, { name: "other" });

    const emptyName = await updateGroup(owner, group.id, { name: "" });
    expect(emptyName.status).toBe(400);
    expect((await errorBody(emptyName)).message).toBe("Group name cannot be empty.");

    const emptyLang = await updateGroup(owner, group.id, { lang_tag: "" });
    expect(emptyLang.status).toBe(400);
    expect((await errorBody(emptyLang)).message).toBe("Group language cannot be empty.");

    const noFields = await updateGroup(owner, group.id, {});
    expect(noFields.status).toBe(400);
    expect((await errorBody(noFields)).message).toBe("Specify at least one field to update.");

    // 值没变：上游的 RowsAffected 是 0，于是这句。仓库里那一列的默认值就是空串。
    const unchanged = await updateGroup(owner, group.id, { description: "" });
    expect(unchanged.status).toBe(400);
    expect((await errorBody(unchanged)).message).toBe("No new fields in group update.");

    const taken = await updateGroup(owner, group.id, { name: "other" });
    expect(taken.status).toBe(400);
    expect(await errorBody(taken)).toEqual({ code: 3, message: "Group name is in use." });
  });

  it("hides the group from a non-admin and rejects a malformed id", async () => {
    const world = await groupWorld(2);
    const [owner, outsider] = world.accounts as [SocialAccount, SocialAccount];
    const group = await mustCreateGroup(owner, { name: "guarded", open: true });
    expect((await joinGroupRequest(outsider, group.id)).status).toBe(200);

    const denied = await updateGroup(outsider, group.id, { description: "x" });
    expect(denied.status).toBe(404);
    expect(await errorBody(denied)).toEqual({
      code: 5,
      message: "Group not found or you're not allowed to update.",
    });

    const malformed = await updateGroup(owner, "not-a-uuid", { description: "x" });
    expect(malformed.status).toBe(400);
    expect((await errorBody(malformed)).message).toBe("Group ID must be a valid ID.");
  });
});

describe("DELETE /v2/group/{groupId}", () => {
  it("lets only a superadmin delete, and removes the group with all of its edges", async () => {
    const world = await groupWorld(2);
    const [owner, member] = world.accounts as [SocialAccount, SocialAccount];
    const group = await mustCreateGroup(owner, { name: "doomed", open: true });
    expect((await memberAction(owner, group.id, "add", [member.id])).status).toBe(200);
    expect((await world.groupEdge(group.id, member.id))?.state).toBe(2);

    const denied = await deleteGroup(member, group.id);
    expect(denied.status).toBe(400);
    expect(await errorBody(denied)).toEqual({
      code: 3,
      message: "Group not found or you're not allowed to delete.",
    });

    const deleted = await deleteGroup(owner, group.id);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({});
    expect(await world.group(group.id)).toBeNull();
    expect(await world.groupEdges(group.id)).toHaveLength(0);
    // 成员那侧的边（用户 → 群）也要一起没：删群是两句 DELETE 的一个批次。
    expect(await world.groupEdge(group.id, member.id)).toBeNull();
  });
});
