import { describe, expect, it } from "vitest";

import { e2eTenant } from "./global-setup";
import { authenticateDevice, call, freshDeviceId, userIdOf } from "./http-helpers";

/**
 * M5 E2E：社交全流程，走真实 HTTP 通道。
 *
 * 存在的唯一目的：把"好友边 → 通知 → 接受 → 互列好友 → 建群 → 加群 → 群列表
 * → 删通知"这条链**在真实 Worker 进程上**跑一遍。集成测试已经逐条断言过库里的行，
 * 但那些断言走的是直接 import 处理函数的路子；没有这条 E2E，路由注册、序列化形状、
 * 状态码就都没有端到端的证据。
 *
 * 目标是一个本地 `wrangler dev --local` 进程（见 `global-setup.ts`），
 * 不连接任何 Cloudflare 账号资源，因此不产生账单。
 *
 * 契约源（机器可读）：
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/friend
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/group
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/notification
 * 契约源: server/api_friend.go::AddFriends
 * 契约源: server/api_group.go::CreateGroup
 * 契约源: server/api_notification.go::ListNotifications
 *
 * REQ-0001-011, REQ-0001-012, REQ-0001-013
 */

interface Player {
  readonly token: string;
  readonly id: string;
  readonly username: string;
}

/** 每次运行都用新的用户名：本地 D1 跨运行保留，固定名字会撞唯一约束。 */
function freshUsername(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function newPlayer(prefix: string): Promise<Player> {
  const username = freshUsername(prefix);
  const session = await authenticateDevice(
    e2eTenant,
    freshDeviceId(prefix),
    `?create=true&username=${username}`,
  );
  return { token: session.session.token, id: await userIdOf(session.session.token), username };
}

interface NotificationLine {
  readonly id: string;
  readonly code?: number;
  readonly subject: string;
  readonly content?: string;
  readonly persistent?: boolean;
}

async function notificationsOf(token: string): Promise<NotificationLine[]> {
  // `limit` 必须显式给：上游的默认值是 **1**，不给就看不到第二条。
  const res = await call("/v2/notification?limit=100", { token });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { notifications?: NotificationLine[] };
  return body.notifications ?? [];
}

interface FriendLine {
  readonly user?: { readonly id: string; readonly username: string };
  readonly state?: number;
}

async function friendsOf(token: string): Promise<FriendLine[]> {
  const res = await call("/v2/friend?limit=100", { token });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { friends?: FriendLine[] };
  return body.friends ?? [];
}

interface GroupLine {
  readonly id: string;
  readonly name: string;
  readonly creator_id: string;
  readonly open?: boolean;
  readonly edge_count?: number;
}

describe("M5 E2E: 社交全流程（真实 HTTP）", () => {
  it("test_friend_request_notification_accept_and_mutual_listing", async () => {
    const alice = await newPlayer("alice");
    const bob = await newPlayer("bob");

    // A → B 发好友请求，`ids` 在 query 上（上游这几条没有 body）。
    const requested = await call(`/v2/friend?ids=${bob.id}`, { token: alice.token, method: "POST" });
    expect(requested.status).toBe(200);
    expect(await requested.json()).toEqual({});

    // B 收到 `-2` 通知，subject 里带 A 的用户名（客户端据此本地化）。
    const bobInbox = await notificationsOf(bob.token);
    const requestNotice = bobInbox.find((line) => line.code === -2);
    expect(requestNotice?.subject).toBe(`${alice.username} wants to add you as a friend`);
    expect(JSON.parse(requestNotice?.content ?? "{}")).toEqual({ username: alice.username });
    expect(requestNotice?.persistent).toBe(true);

    // 此刻 B 看到的边是 INVITE_RECEIVED(2)，A 看到的是 INVITE_SENT(1)。
    expect((await friendsOf(bob.token)).map((line) => line.state)).toEqual([2]);
    expect((await friendsOf(alice.token)).map((line) => line.state)).toEqual([1]);

    // B 回加 = 接受：两边都变 FRIEND(0)。
    const accepted = await call(`/v2/friend?ids=${alice.id}`, { token: bob.token, method: "POST" });
    expect(accepted.status).toBe(200);

    const [aliceFriends, bobFriends] = await Promise.all([
      friendsOf(alice.token),
      friendsOf(bob.token),
    ]);
    expect(aliceFriends.map((line) => [line.user?.id, line.state])).toEqual([[bob.id, 0]]);
    expect(bobFriends.map((line) => [line.user?.id, line.state])).toEqual([[alice.id, 0]]);

    // A 收到 `-3`"接受了好友请求"。
    const aliceInbox = await notificationsOf(alice.token);
    expect(aliceInbox.find((line) => line.code === -3)?.subject).toBe(
      `${bob.username} accepted your friend request`,
    );
  });

  it("test_group_create_join_and_user_group_listing", async () => {
    const alice = await newPlayer("alice");
    const bob = await newPlayer("bob");
    const name = `e2e-group-${crypto.randomUUID().slice(0, 8)}`;

    const created = await call("/v2/group", {
      token: alice.token,
      body: { name, description: "e2e", open: true },
    });
    expect(created.status).toBe(200);
    const group = (await created.json()) as GroupLine;
    expect(group.name).toBe(name);
    expect(group.creator_id).toBe(alice.id);
    expect(group.open).toBe(true);
    // 建群时创建者已入群：只有一条边。
    expect(group.edge_count).toBe(1);

    // 重名建群是 409（上游 `codes.AlreadyExists`）。
    const duplicate = await call("/v2/group", { token: alice.token, body: { name } });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ code: 6, message: "Group name is in use." });

    const joined = await call(`/v2/group/${group.id}/join`, { token: bob.token, method: "POST" });
    expect(joined.status).toBe(200);

    // 两条 `/v2/user/{id}/group` 都把群列出来，且状态是 SUPERADMIN(0) / MEMBER(2)。
    const [aliceGroups, bobGroups] = await Promise.all([
      call(`/v2/user/${alice.id}/group?limit=10`, { token: alice.token }).then((res) => res.json()),
      call(`/v2/user/${bob.id}/group?limit=10`, { token: bob.token }).then((res) => res.json()),
    ]);
    const aliceLines = (aliceGroups as { user_groups?: { group: GroupLine; state: number }[] })
      .user_groups;
    const bobLines = (bobGroups as { user_groups?: { group: GroupLine; state: number }[] })
      .user_groups;
    expect(aliceLines?.map((line) => [line.group.id, line.state])).toEqual([[group.id, 0]]);
    expect(bobLines?.map((line) => [line.group.id, line.state])).toEqual([[group.id, 2]]);

    // 群目录：按名字过滤能查到它，并且 edge_count 已经涨到 2。
    const listed = await call(`/v2/group?name=${name}&limit=10`, { token: alice.token });
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { groups?: GroupLine[] };
    expect(listBody.groups?.map((line) => line.id)).toEqual([group.id]);
    expect(listBody.groups?.[0]?.edge_count).toBe(2);
  });

  it("test_notification_delete_only_removes_own_rows", async () => {
    const alice = await newPlayer("alice");
    const bob = await newPlayer("bob");
    await call(`/v2/friend?ids=${bob.id}`, { token: alice.token, method: "POST" });

    const inbox = await notificationsOf(bob.token);
    expect(inbox).toHaveLength(1);
    const target = inbox[0];
    if (target === undefined) throw new Error("B 的收件箱里没有通知");

    // 别人删不掉我的通知：A 拿 B 的通知 id 去删是成功的空操作，B 的行还在。
    const foreignDelete = await call(`/v2/notification?ids=${target.id}`, {
      token: alice.token,
      method: "DELETE",
    });
    expect(foreignDelete.status).toBe(200);
    expect(await notificationsOf(bob.token)).toHaveLength(1);

    const ownDelete = await call(`/v2/notification?ids=${target.id}`, {
      token: bob.token,
      method: "DELETE",
    });
    expect(ownDelete.status).toBe(200);
    expect(await notificationsOf(bob.token)).toHaveLength(0);
  });
});
