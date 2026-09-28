import { describe, expect, it } from "vitest";

import { errorBody, type SocialAccount } from "../../helpers/social-world";
import { bearer, call } from "../../helpers/tenants";
import { groupWorld, mustCreateGroup } from "../../helpers/group-world";

/**
 * 群目录（`GET /v2/group`）：九条排序分支里最常被用到的几条 + 两种游标错误。
 *
 * 三处与直觉不同、这里显式钉住的地方：
   - **默认 `limit` 是 1**（不是 100）：不给 `limit` 只回一个群；
   - **`name` 与其它过滤条件互斥**（`name filter cannot be combined with any other filter`）；
   - 游标坏掉时报 `Malformed cursor was used.`，与成员列表的 `Cursor is invalid.` **不同**。
 *
 * 还有一条是本项目**必须**做的：群目录要按租户隔离（ECN-0001）。少了 `tenant_id`
 * 条件，A 租户的玩家会在群目录里看到 B 租户的群——所以这里有一条跨租户的负向用例。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_group.go::ListGroups
 * 契约源: server/core_group.go::ListGroups
 *
 * REQ-0001-012
 */

interface GroupListResponse {
  readonly groups?: readonly { readonly id: string; readonly name: string; readonly open: boolean }[];
  readonly cursor?: string;
}

async function listGroups(account: SocialAccount, query = ""): Promise<GroupListResponse> {
  const response = await call(`/v2/group${query}`, { authorization: bearer(account.token) });
  expect(response.status).toBe(200);
  return (await response.json()) as GroupListResponse;
}

function rawListGroups(account: SocialAccount, query = ""): Promise<Response> {
  return call(`/v2/group${query}`, { authorization: bearer(account.token) });
}

describe("GET /v2/group", () => {
  it("defaults to a single group and walks the rest with the cursor", async () => {
    const world = await groupWorld(1);
    const [owner] = world.accounts as [SocialAccount];
    const created = [
      await mustCreateGroup(owner, { name: "page-a", open: true }),
      await mustCreateGroup(owner, { name: "page-b", open: true }),
      await mustCreateGroup(owner, { name: "page-c", open: true }),
    ];

    const first = await listGroups(owner);
    expect(first.groups).toHaveLength(1);
    expect(first.cursor).toBeDefined();

    const seen = [first.groups?.[0]?.id];
    let cursor = first.cursor ?? "";
    while (cursor !== "") {
      const page = await listGroups(owner, `?cursor=${encodeURIComponent(cursor)}`);
      expect(page.groups?.length ?? 0).toBeLessThanOrEqual(1);
      for (const group of page.groups ?? []) seen.push(group.id);
      cursor = page.cursor ?? "";
    }

    expect(new Set(seen)).toEqual(new Set(created.map((group) => group.id)));
    expect(seen).toHaveLength(3);
  });

  it("filters by name, by open, by langTag and by members", async () => {
    const world = await groupWorld(2);
    const [owner, joiner] = world.accounts as [SocialAccount, SocialAccount];
    const open = await mustCreateGroup(owner, { name: "fox", open: true, lang_tag: "en" });
    const closed = await mustCreateGroup(owner, { name: "wolf", lang_tag: "zh" });
    await mustCreateGroup(owner, { name: "bear", open: true, lang_tag: "en" });
    // `bear` 有两个人：后面靠 `members` 这个条件把两只群分开。
    const bear = (await listGroups(owner, "?name=bear")).groups?.[0];
    expect(bear?.name).toBe("bear");

    // name 只按名字匹配（`LIKE` + 上游的 TrimLeft("% ")），命中一个。
    const byName = await listGroups(owner, "?name=fox");
    expect(byName.groups?.map((group) => group.name)).toEqual(["fox"]);

    const byOpen = await listGroups(owner, "?open=true&limit=100");
    expect(byOpen.groups?.map((group) => group.name).sort()).toEqual(["bear", "fox"]);
    const byClosed = await listGroups(owner, "?open=false&limit=100");
    expect(byClosed.groups?.map((group) => group.name)).toEqual(["wolf"]);

    const byLang = await listGroups(owner, "?langTag=en&limit=100");
    expect(byLang.groups?.map((group) => group.name).sort()).toEqual(["bear", "fox"]);
    expect(byLang.groups?.[0]?.id).toBeDefined();

    // 让 fox 变成两人群，`members=1` 就只剩两个人以下的那几个。
    const join = await call(`/v2/group/${open.id}/join`, {
      method: "POST",
      authorization: bearer(joiner.token),
    });
    expect(join.status).toBe(200);
    const few = await listGroups(owner, "?members=1&limit=100");
    expect(few.groups?.map((group) => group.name).sort()).toEqual(["bear", "wolf"]);
    expect(closed.id).toBeDefined();
  });

  it("rejects a name combined with other filters and a malformed cursor", async () => {
    const world = await groupWorld(1);
    const [owner] = world.accounts as [SocialAccount];
    await mustCreateGroup(owner, { name: "solo", open: true });

    const combined = await rawListGroups(owner, "?name=solo&open=true");
    expect(combined.status).toBe(400);
    expect(await errorBody(combined)).toEqual({
      code: 3,
      message: "name filter cannot be combined with any other filter",
    });

    const badCursor = await rawListGroups(owner, "?cursor=not-a-cursor");
    expect(badCursor.status).toBe(400);
    expect((await errorBody(badCursor)).message).toBe("Malformed cursor was used.");

    const badLimit = await rawListGroups(owner, "?limit=0");
    expect(badLimit.status).toBe(400);
    expect((await errorBody(badLimit)).message).toBe(
      "Invalid limit - limit must be between 1 and 100.",
    );
  });

  it("never lists another tenant's groups", async () => {
    const alpha = await groupWorld(1);
    const beta = await groupWorld(1);
    const [alphaOwner] = alpha.accounts as [SocialAccount];
    const [betaOwner] = beta.accounts as [SocialAccount];
    await mustCreateGroup(alphaOwner, { name: "alpha-only", open: true });

    const mine = await listGroups(alphaOwner, "?name=alpha-only");
    expect(mine.groups?.map((group) => group.name)).toEqual(["alpha-only"]);
    expect(mine.groups?.[0]?.open).toBe(true);

    // 同名的群不存在于 beta 租户；没有租户条件时这里会看到 alpha 那一行。
    const theirs = await listGroups(betaOwner, "?name=alpha-only");
    expect(theirs.groups).toBeUndefined();
    const all = await listGroups(betaOwner, "?limit=100");
    expect(all.groups).toBeUndefined();
  });
});
