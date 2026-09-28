import { describe, expect, it } from "vitest";

import { becomeFriends, errorBody, socialWorld, type SocialAccount } from "../../helpers/social-world";
import { bearer, call } from "../../helpers/tenants";

/**
 * 解除好友与拉黑。
 *
 * 上游 `deleteFriend` 与 `blockFriend` 的判据都是"这次写入改到了几行"，所以这里的
 * 断言也以**库里的行数变化**为主：
 *   - 删：双方都有边（2 行）才算解除一段关系，此时才发 `-9`；只删到 1 行是"我单方面
 *     拉黑对方"的静默解封，不发通知；删不到是无声的空操作；
 *   - 拉黑：我的边变 `BLOCKED(3)`、对方朝向我的非拉黑边被删、`edge_count` 随之维护；
 *     拉黑之后对方再怎么加都写不进去（INSERT 的 `NOT EXISTS ... state = 3`）。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_friend.go::DeleteFriends
 * 契约源: server/api_friend.go::BlockFriends
 * 契约源: server/core_friend.go::deleteFriend
 * 契约源: server/core_friend.go::blockFriend
 *
 * REQ-0001-011
 */

function removeFriend(from: SocialAccount, target: SocialAccount): Promise<Response> {
  return call(`/v2/friend?ids=${encodeURIComponent(target.id)}`, {
    method: "DELETE",
    authorization: bearer(from.token),
  });
}

function blockFriend(from: SocialAccount, target: SocialAccount): Promise<Response> {
  return call(`/v2/friend/block?ids=${encodeURIComponent(target.id)}`, {
    method: "POST",
    authorization: bearer(from.token),
  });
}

function addFriend(from: SocialAccount, target: SocialAccount): Promise<Response> {
  return call(`/v2/friend?ids=${encodeURIComponent(target.id)}`, {
    method: "POST",
    authorization: bearer(from.token),
  });
}

describe("DELETE /v2/friend", () => {
  it("removes both edges of a friendship, drops the counters and notifies", async () => {
    const world = await socialWorld(2);
    const [me, other] = world.accounts as [SocialAccount, SocialAccount];
    await becomeFriends(me, other);

    const response = await removeFriend(me, other);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(await world.edge(me.id, other.id)).toBeNull();
    expect(await world.edge(other.id, me.id)).toBeNull();
    expect(await world.edgeCount(me.id)).toBe(0);
    expect(await world.edgeCount(other.id)).toBe(0);

    const notifications = await world.notifications(other.id);
    const removal = notifications.find((row) => row.code === -9);
    expect(removal?.subject).toBe(`${me.username} removed you as a friend`);
    expect(removal?.sender_id).toBe(me.id);
  });

  it("is a silent no-op when there is no relationship", async () => {
    const world = await socialWorld(2);
    const [me, other] = world.accounts as [SocialAccount, SocialAccount];
    const response = await removeFriend(me, other);
    expect(response.status).toBe(200);
    expect(await world.notifications(other.id)).toHaveLength(0);
  });

  it("succeeds on an empty request and rejects removing yourself", async () => {
    const world = await socialWorld(1);
    const [me] = world.accounts as [SocialAccount];
    expect((await call("/v2/friend", { method: "DELETE", authorization: bearer(me.token) })).status).toBe(200);

    const self = await removeFriend(me, me);
    expect(self.status).toBe(400);
    expect(await errorBody(self)).toEqual({ code: 3, message: "Cannot delete self." });
  });

  it("treats an unknown username as a successful empty operation", async () => {
    const world = await socialWorld(2);
    const [me, other] = world.accounts as [SocialAccount, SocialAccount];
    await becomeFriends(me, other);
    const response = await call("/v2/friend?usernames=nobody-here-0002", {
      method: "DELETE",
      authorization: bearer(me.token),
    });
    expect(response.status).toBe(200);
    // 关系还在：没有可解析的目标时上游不是报错，而是什么都不做。
    expect((await world.edge(me.id, other.id))?.state).toBe(0);
  });
});

describe("POST /v2/friend/block", () => {
  it("blocks a friend and removes their edge towards me", async () => {
    const world = await socialWorld(2);
    const [me, other] = world.accounts as [SocialAccount, SocialAccount];
    await becomeFriends(me, other);

    const response = await blockFriend(me, other);
    expect(response.status).toBe(200);
    expect((await world.edge(me.id, other.id))?.state).toBe(3);
    expect(await world.edge(other.id, me.id)).toBeNull();
    expect(await world.edgeCount(me.id)).toBe(1);
    expect(await world.edgeCount(other.id)).toBe(0);
  });

  it("creates the blocked edge when there was no relationship", async () => {
    const world = await socialWorld(2);
    const [me, other] = world.accounts as [SocialAccount, SocialAccount];
    expect((await blockFriend(me, other)).status).toBe(200);
    expect((await world.edge(me.id, other.id))?.state).toBe(3);
    expect(await world.edgeCount(me.id)).toBe(1);
  });

  it("ignores a user that does not exist", async () => {
    const world = await socialWorld(1);
    const [me] = world.accounts as [SocialAccount];
    const ghost = crypto.randomUUID().toUpperCase();
    const response = await call(`/v2/friend/block?ids=${encodeURIComponent(ghost)}`, {
      method: "POST",
      authorization: bearer(me.token),
    });
    expect(response.status).toBe(200);
    expect(await world.edge(me.id, ghost)).toBeNull();
    expect(await world.edgeCount(me.id)).toBe(0);
  });

  it("rejects blocking yourself", async () => {
    const world = await socialWorld(1);
    const [me] = world.accounts as [SocialAccount];
    const response = await blockFriend(me, me);
    expect(response.status).toBe(400);
    expect(await errorBody(response)).toEqual({ code: 3, message: "Cannot block self." });
  });
});

describe("被拉黑的一方", () => {
  it("cannot add the blocker as a friend", async () => {
    const world = await socialWorld(2);
    const [me, other] = world.accounts as [SocialAccount, SocialAccount];
    expect((await blockFriend(me, other)).status).toBe(200);

    const attempt = await addFriend(other, me);
    expect(attempt.status).toBe(200);
    expect(await world.edge(other.id, me.id)).toBeNull();
    expect((await world.edge(me.id, other.id))?.state).toBe(3);
    expect(await world.notifications(me.id)).toHaveLength(0);
  });
});
