import { describe, expect, it } from "vitest";

import {
  becomeFriends,
  socialWorld,
  type SocialAccount,
  type SocialWorld,
} from "../../helpers/social-world";
import { bearer, call } from "../../helpers/tenants";

/**
 * 上游 `server/core_friend_test.go::TestServer_ListFriendsOfFriends` 的搬运版。
 *
 * 结构刻意与上游一致：**四个子用例共用一个社交图，且有先后依赖**——上游也是这么写的
 * （先断言"没有好友时为空"，再往同一个库里加边，然后断言后面三件事）。这不是偷懒，
 * 而是"空表"这个前置状态本身就要求在没有边的时刻断言。为了保持这种依赖又不在
 * 用例之间偷偷串状态，社交图只在第二次用到时**惰性构造一次**。
 *
 * 社交图（与上游逐条对应）：
 *   uid 的好友：A1、B1、B3
 *   A1 的好友：uid、A2、A3
 *   B1 的好友：uid、B2、B3
 *   B3 的好友：B1
 * 于是"好友的好友"只有 A2、A3、B2 三人，各自的 referrer 分别是 A1、A1、B1。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_friend_test.go::TestServer_ListFriendsOfFriends
 * 契约源: server/core_friend.go::ListFriendsOfFriends
 *
 * 溯源: server/core_friend_test.go::TestServer_ListFriendsOfFriends
 *
 * REQ-0001-011
 */

interface Graph {
  readonly uid: SocialAccount;
  readonly a1: SocialAccount;
  readonly a2: SocialAccount;
  readonly a3: SocialAccount;
  readonly b1: SocialAccount;
  readonly b2: SocialAccount;
  readonly b3: SocialAccount;
}

let world: SocialWorld | null = null;
let graph: Graph | null = null;

function currentWorld(): SocialWorld {
  if (world === null) throw new Error("社交图还没建好");
  return world;
}

async function ensureGraph(): Promise<Graph> {
  if (graph !== null) return graph;
  const source = currentWorld();
  const made: Graph = {
    uid: await source.newAccount(),
    a1: await source.newAccount(),
    a2: await source.newAccount(),
    a3: await source.newAccount(),
    b1: await source.newAccount(),
    b2: await source.newAccount(),
    b3: await source.newAccount(),
  };
  await becomeFriends(made.uid, made.a1);
  await becomeFriends(made.a1, made.a2);
  await becomeFriends(made.a1, made.a3);
  await becomeFriends(made.uid, made.b1);
  await becomeFriends(made.b1, made.b2);
  await becomeFriends(made.b1, made.b3);
  await becomeFriends(made.uid, made.b3);
  graph = made;
  return made;
}

interface FriendsOfFriendsEntry {
  readonly referrer: string;
  readonly user: { readonly id: string; readonly username: string };
}

interface FriendsOfFriendsBody {
  readonly friends_of_friends?: readonly FriendsOfFriendsEntry[];
  readonly cursor?: string;
}

async function listFriendsOfFriends(
  account: SocialAccount,
  query = "",
): Promise<FriendsOfFriendsBody> {
  const response = await call(`/v2/friend/friends${query}`, { authorization: bearer(account.token) });
  expect(response.status).toBe(200);
  return (await response.json()) as FriendsOfFriendsBody;
}

describe("ListFriendsOfFriends（上游 core_friend_test.go 的搬运）", () => {
  it("returns empty list if the user has no friends", async () => {
    world = await socialWorld(1);
    const body = await listFriendsOfFriends(currentWorld().accounts[0] as SocialAccount);
    expect(body.friends_of_friends ?? []).toHaveLength(0);
    expect(body.cursor ?? "").toBe("");
  });

  it("returns friends of friends, excluding friends in common", async () => {
    const made = await ensureGraph();
    const body = await listFriendsOfFriends(made.uid, "?limit=100");
    const entries = body.friends_of_friends ?? [];
    expect(entries).toHaveLength(3);

    const referrerOf = new Map(entries.map((entry) => [entry.user.id, entry.referrer]));
    expect(referrerOf.get(made.a2.id)).toBe(made.a1.id);
    expect(referrerOf.get(made.a3.id)).toBe(made.a1.id);
    expect(referrerOf.get(made.b2.id)).toBe(made.b1.id);

    // 共同好友（A1/B1/B3）不能出现在结果里——它们已经是 uid 的好友。
    const ids = new Set(entries.map((entry) => entry.user.id));
    expect(ids.has(made.uid.id)).toBe(false);
    expect(ids.has(made.a1.id)).toBe(false);
    expect(ids.has(made.b1.id)).toBe(false);
    expect(ids.has(made.b3.id)).toBe(false);
  });

  it("returns a cursor if there's more pages to fetch", async () => {
    const made = await ensureGraph();
    const body = await listFriendsOfFriends(made.uid, "?limit=1");
    expect(body.friends_of_friends ?? []).toHaveLength(1);
    expect(body.cursor ?? "").not.toBe("");
  });

  it("returns the following page if a cursor is provided", async () => {
    const made = await ensureGraph();
    const firstPage = await listFriendsOfFriends(made.uid, "?limit=2");
    expect(firstPage.friends_of_friends ?? []).toHaveLength(2);
    expect(firstPage.cursor ?? "").not.toBe("");

    const secondPage = await listFriendsOfFriends(
      made.uid,
      `?limit=2&cursor=${encodeURIComponent(firstPage.cursor as string)}`,
    );
    expect(secondPage.friends_of_friends ?? []).toHaveLength(1);
    expect(secondPage.cursor ?? "").toBe("");

    // 两页之间不重不漏：合起来正好是三个人。
    const ids = [
      ...(firstPage.friends_of_friends ?? []),
      ...(secondPage.friends_of_friends ?? []),
    ].map((entry) => entry.user.id);
    expect(new Set(ids).size).toBe(3);
  });
});
