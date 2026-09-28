import { describe, expect, it } from "vitest";

import {
  errorBody,
  requestFriend,
  socialWorld,
  type SocialAccount,
} from "../../helpers/social-world";
import { bearer, call } from "../../helpers/tenants";

/**
 * `GET /v2/notification` 的三条形状（都来自上游 `core_notification.go`）：
 *
 *   1. **默认 `limit` 是 1**：不传就只回一条。客户端 SDK 的"拉取未读"轮询靠它；
 *   2. `cacheable_cursor` **空列表也给**（不带游标时给"零点游标"，带游标时原样回带），
 *      所以客户端可以永远带着它翻页；
 *   3. 列表里每条通知的 `persistent` **恒为 true**——能列出来就说明它落库了。
 *
 * 通知的来源用**好友请求**（`-2`）：它是本项目里最轻的一条会写通知的路径，
 * 而这里要断言的只是"通知端点怎么读"，不是"谁写的"。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_notification.go::ListNotifications
 * 契约源: server/core_notification.go::NotificationList
 *
 * REQ-0001-013
 */

interface NotificationListResponse {
  readonly notifications?: readonly {
    readonly id: string;
    readonly subject: string;
    readonly content?: string;
    readonly code?: number;
    readonly sender_id?: string;
    readonly create_time: string;
    readonly persistent?: boolean;
  }[];
  readonly cacheable_cursor?: string;
}

function listNotifications(account: SocialAccount, query = ""): Promise<Response> {
  return call(`/v2/notification${query}`, { authorization: bearer(account.token) });
}

async function readList(account: SocialAccount, query = ""): Promise<NotificationListResponse> {
  const response = await listNotifications(account, query);
  expect(response.status).toBe(200);
  return (await response.json()) as NotificationListResponse;
}

describe("GET /v2/notification", () => {
  it("returns one notification by default and walks the rest with the cacheable cursor", async () => {
    const world = await socialWorld(3);
    const [sender, other, target] = world.accounts as [
      SocialAccount,
      SocialAccount,
      SocialAccount,
    ];
    expect((await requestFriend(sender, target)).status).toBe(200);
    expect((await requestFriend(other, target)).status).toBe(200);

    const first = await readList(target);
    expect(first.notifications).toHaveLength(1);
    expect(first.cacheable_cursor).toBeDefined();

    const second = await readList(
      target,
      `?cacheable_cursor=${encodeURIComponent(first.cacheable_cursor ?? "")}`,
    );
    expect(second.notifications).toHaveLength(1);
    expect(second.notifications?.[0]?.id).not.toBe(first.notifications?.[0]?.id);

    // 两条都读完之后再翻页：空列表 + 原样回带的游标（客户端可以一直拿着它轮询）。
    const third = await readList(
      target,
      `?cacheable_cursor=${encodeURIComponent(second.cacheable_cursor ?? "")}`,
    );
    expect(third.notifications).toBeUndefined();
    expect(third.cacheable_cursor).toBe(second.cacheable_cursor);
  });

  it("describes a notification with the upstream's field shapes", async () => {
    const world = await socialWorld(2);
    const [sender, target] = world.accounts as [SocialAccount, SocialAccount];
    expect((await requestFriend(sender, target)).status).toBe(200);

    const body = await readList(target, "?limit=100");
    const entry = body.notifications?.[0];
    expect(entry?.code).toBe(-2);
    expect(entry?.sender_id).toBe(sender.id);
    expect(entry?.subject).toBe(`${sender.username} wants to add you as a friend`);
    expect(JSON.parse(entry?.content ?? "{}")).toEqual({ username: sender.username });
    expect(entry?.persistent).toBe(true);
    expect(entry?.create_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);

    // 两种 query 写法指向同一个字段（grpc-gateway 的驼峰名与 proto 的下划线名）。
    const snake = await readList(target, `?cacheable_cursor=${encodeURIComponent("")}`);
    expect(snake.cacheable_cursor).toBeDefined();
  });

  it("returns a zero cursor for an empty list and rejects bad input", async () => {
    const world = await socialWorld(1);
    const [lonely] = world.accounts as [SocialAccount];

    const empty = await readList(lonely);
    expect(empty.notifications).toBeUndefined();
    expect(empty.cacheable_cursor).toBeDefined();

    const badCursor = await listNotifications(lonely, "?cacheable_cursor=%7Bnot-json");
    expect(badCursor.status).toBe(400);
    expect(await errorBody(badCursor)).toEqual({
      code: 3,
      message: "Malformed cursor was used.",
    });

    const badLimit = await listNotifications(lonely, "?limit=101");
    expect(badLimit.status).toBe(400);
    expect((await errorBody(badLimit)).message).toBe(
      "Invalid limit - limit must be between 1 and 100.",
    );
  });

  it("never lists another tenant's notifications", async () => {
    const alpha = await socialWorld(2);
    const beta = await socialWorld(1);
    const [sender, target] = alpha.accounts as [SocialAccount, SocialAccount];
    const [stranger] = beta.accounts as [SocialAccount];
    expect((await requestFriend(sender, target)).status).toBe(200);

    expect((await readList(target, "?limit=100")).notifications).toHaveLength(1);
    expect((await readList(stranger, "?limit=100")).notifications).toBeUndefined();
  });
});
