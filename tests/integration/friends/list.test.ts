import { describe, expect, it } from "vitest";

import { errorBody, socialWorld, type SocialAccount } from "../../helpers/social-world";
import { bearer, call } from "../../helpers/tenants";

/**
 * `GET /v2/friend` 的可观测契约：默认 limit、状态过滤、游标与它的三条拒绝理由。
 *
 * 每一条期望值都来自上游（`api_friend.go::ListFriends` + `core_friend.go::ListFriends`）：
 *   - 不传 limit 时是 1000（上游的默认值，不是 100）；
 *   - limit 只接受 1..1000，state 只接受 0..3；
 *   - 坏游标与"游标里的 state 与过滤条件不一致"报的是同一句 `Cursor is invalid.`；
 *   - 列表按 (state, position) 升序，游标指向下一页的第一行。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_friend.go::ListFriends
 * 契约源: server/core_friend.go::ListFriends
 *
 * REQ-0001-011
 */

interface FriendBody {
  readonly user: { readonly id: string; readonly username: string; readonly create_time: string };
  readonly state: number;
  readonly update_time: string;
  readonly metadata?: string;
}

interface FriendListBody {
  readonly friends?: readonly FriendBody[];
  readonly cursor?: string;
}

async function listFriends(account: SocialAccount, query = ""): Promise<Response> {
  return call(`/v2/friend${query}`, { authorization: bearer(account.token) });
}

async function listOk(account: SocialAccount, query = ""): Promise<FriendListBody> {
  const response = await listFriends(account, query);
  expect(response.status).toBe(200);
  return (await response.json()) as FriendListBody;
}

/** 发一条好友请求（参数在 query 上，见路由文件头）。 */
function request(from: SocialAccount, target: SocialAccount): Promise<Response> {
  return call(`/v2/friend?ids=${encodeURIComponent(target.id)}`, {
    method: "POST",
    authorization: bearer(from.token),
  });
}

describe("GET /v2/friend", () => {
  it("returns an empty object when the user has no edges", async () => {
    const world = await socialWorld(1);
    const body = await listOk(world.accounts[0] as SocialAccount);
    expect(body).toEqual({});
  });

  it("defaults to limit 1000 and echoes the state as a bare number", async () => {
    const world = await socialWorld(1);
    const [me] = world.accounts as [SocialAccount];
    const first = await world.newAccount();
    const second = await world.newAccount();
    expect((await request(me, first)).status).toBe(200);
    expect((await request(me, second)).status).toBe(200);

    const body = await listOk(me);
    expect(body.friends).toHaveLength(2);
    for (const friend of body.friends ?? []) {
      // 我发出去的邀请：state = 1（INVITE_SENT）。它是包装类型，所以 0 也会输出，
      // 且序列化成裸数字而不是 {"value":1}。
      expect(friend.state).toBe(1);
      expect(friend.user.id).toMatch(/^[0-9A-F-]{36}$/u);
      expect(friend.update_time).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(friend.metadata).toBe("{}");
    }
  });

  it("filters by state from both sides of the same edge", async () => {
    const world = await socialWorld(1);
    const [me] = world.accounts as [SocialAccount];
    const other = await world.newAccount();
    expect((await request(me, other)).status).toBe(200);

    const sent = await listOk(me, "?state=1");
    expect(sent.friends?.map((friend) => friend.user.id)).toEqual([other.id]);
    expect(await listOk(me, "?state=0")).toEqual({});
    expect(await listOk(me, "?state=2")).toEqual({});

    const received = await listOk(other, "?state=2");
    expect(received.friends?.map((friend) => friend.user.id)).toEqual([me.id]);
    expect(await listOk(other, "?state=1")).toEqual({});
  });
});

describe("GET /v2/friend 的分页与拒绝理由", () => {
  it("pages with a cursor without skipping or repeating", async () => {
    const world = await socialWorld(1);
    const [me] = world.accounts as [SocialAccount];
    const others = [await world.newAccount(), await world.newAccount(), await world.newAccount()];
    for (const other of others) expect((await request(me, other)).status).toBe(200);

    const first = await listOk(me, "?limit=2");
    expect(first.friends).toHaveLength(2);
    expect(first.cursor).toBeTruthy();

    const second = await listOk(me, `?limit=2&cursor=${encodeURIComponent(first.cursor ?? "")}`);
    expect(second.friends).toHaveLength(1);
    expect(second.cursor ?? "").toBe("");

    const seen = [...(first.friends ?? []), ...(second.friends ?? [])].map((friend) => friend.user.id);
    expect(new Set(seen)).toEqual(new Set(others.map((other) => other.id)));
  });

  it("rejects an out-of-range limit and state", async () => {
    const world = await socialWorld(1);
    const [me] = world.accounts as [SocialAccount];

    const lowLimit = await listFriends(me, "?limit=0");
    expect(lowLimit.status).toBe(400);
    expect(await errorBody(lowLimit)).toEqual({
      code: 3,
      message: "Invalid limit - limit must be between 1 and 1000.",
    });

    const highLimit = await listFriends(me, "?limit=1001");
    expect(highLimit.status).toBe(400);
    expect((await errorBody(highLimit)).message).toBe(
      "Invalid limit - limit must be between 1 and 1000.",
    );

    const state = await listFriends(me, "?state=4");
    expect(state.status).toBe(400);
    expect(await errorBody(state)).toEqual({
      code: 3,
      message: "Invalid state - state must be between 0 and 3.",
    });
  });

  it("rejects a malformed cursor and a cursor that disagrees with the filter", async () => {
    const world = await socialWorld(1);
    const [me] = world.accounts as [SocialAccount];
    const other = await world.newAccount();
    expect((await request(me, other)).status).toBe(200);

    const malformed = await listFriends(me, "?cursor=not-a-cursor");
    expect(malformed.status).toBe(400);
    expect(await errorBody(malformed)).toEqual({ code: 3, message: "Cursor is invalid." });

    // 第二条边是必需的：只有存在"下一页"时上游才会给出游标。
    const extra = await world.newAccount();
    expect((await request(me, extra)).status).toBe(200);

    // 拿"state=1 的下一页游标"去查 state=2：上游认为这是旧游标配新过滤条件，同样报无效。
    const first = await listOk(me, "?state=1&limit=1");
    expect(first.cursor).toBeTruthy();
    const mismatched = await listFriends(
      me,
      `?state=2&cursor=${encodeURIComponent(first.cursor ?? "")}`,
    );
    expect(mismatched.status).toBe(400);
    expect(await errorBody(mismatched)).toEqual({ code: 3, message: "Cursor is invalid." });
  });
});
