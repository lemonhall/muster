import { describe, expect, it } from "vitest";

import { errorBody, socialWorld, type SocialAccount } from "../../helpers/social-world";
import { bearer, call } from "../../helpers/tenants";

/**
 * 加好友的状态机与它产生的通知。
 *
 * 断言分两层：HTTP 面只证明"调用成功"，**库里的行才是事实**——边状态、边计数、
 * 通知的 subject/content/code/sender。上游的行为逐条对应：
 *   - A 加 B：A 侧 `INVITE_SENT(1)`、B 侧 `INVITE_RECEIVED(2)`，两行**同一个 position**，
 *     双方 `edge_count` 各 +1，B 收到一条 `-2` `<A> wants to add you as a friend`；
 *   - B 再回加 A：两行一起变 `FRIEND(0)`，A 收到一条 `-3` `<B> accepted your friend request`；
 *   - 重复加：一条通知都不多发（库里的行没变，自然没有新通知）。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_friend.go::AddFriends
 * 契约源: server/core_friend.go::AddFriends
 * 契约源: server/core_friend.go::addFriend
 *
 * REQ-0001-011
 */

interface FriendRequestBody {
  readonly ids?: readonly string[];
  readonly usernames?: readonly string[];
  readonly metadata?: string;
}

function friendQuery(input: FriendRequestBody): string {
  const parts: string[] = [];
  for (const id of input.ids ?? []) parts.push(`ids=${encodeURIComponent(id)}`);
  for (const username of input.usernames ?? []) parts.push(`usernames=${encodeURIComponent(username)}`);
  if (input.metadata !== undefined) parts.push(`metadata=${encodeURIComponent(input.metadata)}`);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

function addFriend(from: SocialAccount, input: FriendRequestBody): Promise<Response> {
  return call(`/v2/friend${friendQuery(input)}`, {
    method: "POST",
    authorization: bearer(from.token),
  });
}

describe("POST /v2/friend（加好友与接受邀请）", () => {
  it("writes both directions of an invite and notifies the target", async () => {
    const world = await socialWorld(2);
    const [me, other] = world.accounts as [SocialAccount, SocialAccount];
    const response = await addFriend(me, { ids: [other.id], metadata: '{"a":1}' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});

    const mine = await world.edge(me.id, other.id);
    const theirs = await world.edge(other.id, me.id);
    expect(mine?.state).toBe(1);
    expect(theirs?.state).toBe(2);
    expect(mine?.position).toBe(theirs?.position);
    expect(mine?.metadata).toBe('{"a":1}');
    // 反向边的 metadata 固定是空对象（上游那段 VALUES 里写死 '{}'::JSONB）。
    expect(theirs?.metadata).toBe("{}");

    expect(await world.edgeCount(me.id)).toBe(1);
    expect(await world.edgeCount(other.id)).toBe(1);

    const received = await world.notifications(other.id);
    expect(received).toHaveLength(1);
    expect(received[0]?.code).toBe(-2);
    expect(received[0]?.subject).toBe(`${me.username} wants to add you as a friend`);
    expect(received[0]?.content).toBe(JSON.stringify({ username: me.username }));
    expect(received[0]?.sender_id).toBe(me.id);
    expect(await world.notifications(me.id)).toHaveLength(0);
  });

  it("accepts an invite when the other side adds back", async () => {
    const world = await socialWorld(2);
    const [me, other] = world.accounts as [SocialAccount, SocialAccount];
    expect((await addFriend(me, { ids: [other.id] })).status).toBe(200);
    expect((await addFriend(other, { ids: [me.id] })).status).toBe(200);

    expect((await world.edge(me.id, other.id))?.state).toBe(0);
    expect((await world.edge(other.id, me.id))?.state).toBe(0);

    const accepted = await world.notifications(me.id);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.code).toBe(-3);
    expect(accepted[0]?.subject).toBe(`${other.username} accepted your friend request`);
    expect(accepted[0]?.sender_id).toBe(other.id);

    // 对方那条"-2 请求"不会被删掉：通知是收件箱，不是状态。
    expect(await world.notifications(other.id)).toHaveLength(1);
  });

  it("resolves a friend by username", async () => {
    const world = await socialWorld(2);
    const [me, other] = world.accounts as [SocialAccount, SocialAccount];
    const response = await addFriend(me, { usernames: [other.username] });
    expect(response.status).toBe(200);
    expect((await world.edge(me.id, other.id))?.state).toBe(1);
    expect((await world.edge(other.id, me.id))?.state).toBe(2);
  });

  it("does not write a second edge or a second notification when re-adding", async () => {
    const world = await socialWorld(2);
    const [me, other] = world.accounts as [SocialAccount, SocialAccount];
    expect((await addFriend(me, { ids: [other.id] })).status).toBe(200);
    const position = (await world.edge(me.id, other.id))?.position;
    expect((await addFriend(me, { ids: [other.id] })).status).toBe(200);

    expect((await world.edge(me.id, other.id))?.position).toBe(position);
    expect(await world.edgeCount(me.id)).toBe(1);
    expect(await world.notifications(other.id)).toHaveLength(1);
  });
});

describe("POST /v2/friend 的入参校验", () => {
  it("treats an empty request as success", async () => {
    const world = await socialWorld(1);
    const [me] = world.accounts as [SocialAccount];
    const response = await addFriend(me, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });

  it("rejects adding yourself", async () => {
    const world = await socialWorld(1);
    const [me] = world.accounts as [SocialAccount];
    const response = await addFriend(me, { ids: [me.id] });
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toEqual({ code: 3, message: "Cannot add self as friend." });
  });

  it("rejects a malformed user id, keeping the offending value", async () => {
    const world = await socialWorld(1);
    const [me] = world.accounts as [SocialAccount];
    const response = await addFriend(me, { ids: ["zzz"] });
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toEqual({ code: 3, message: "Invalid user ID 'zzz'." });
  });

  it("rejects an empty or unknown username", async () => {
    const world = await socialWorld(1);
    const [me] = world.accounts as [SocialAccount];

    const empty = await addFriend(me, { usernames: [""] });
    expect(empty.status).toBe(400);
    expect(await errorBody(empty)).toEqual({ code: 3, message: "Username must not be empty." });

    const unknown = await addFriend(me, { usernames: ["nobody-here-0001"] });
    expect(unknown.status).toBe(400);
    expect(await errorBody(unknown)).toEqual({
      code: 3,
      message: "No valid ID or username was provided.",
    });
  });

  it("rejects adding yourself by username", async () => {
    const world = await socialWorld(1);
    const [me] = world.accounts as [SocialAccount];
    const response = await addFriend(me, { usernames: [me.username] });
    expect(response.status).toBe(400);
    expect((await errorBody(response)).message).toBe("Cannot add self as friend.");
  });
});
