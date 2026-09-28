import { afterEach, describe, expect, it } from "vitest";

import {
  CALLER,
  PEER,
  channelHistoryPath,
  channelWorld,
  closeAllWorlds,
  directChannelId,
  listChannelHistory,
  listChannelHistoryAs,
  roomChannelId,
  sessionId,
} from "../../helpers/channel-world";
import {
  channelJoinEnvelope,
  channelReply,
  joinRoom,
  sendChannelMessage,
} from "../../helpers/channel";
import { errorBody } from "../../helpers/identity-fixtures";
import { sendFrame, waitForFrame, type TestSocket } from "../../helpers/realtime-socket";
import { call } from "../../helpers/tenants";

/**
 * M4 契约测试：频道历史的读路径——REST 端点 `GET /v2/channel/{channelId}`。
 *
 * 上游把这条路的校验拆在两个函数里（`api_channel.go` 与 `core_channel.go`），
 * 顺序是**可观测契约**，这里逐条钉住：
 *
 * | 顺序 | 条件 | 回什么 |
 * |---|---|---|
 * | 1 | 缺 channel_id | `Invalid channel ID.` |
 * | 2 | limit 不在 1..100 | `Invalid limit - limit must be between 1 and 100.` |
 * | 3 | 频道 id 解不出来 | `Invalid channel ID.` |
 * | 4 | 游标解不出来 / 不是这个频道 / 方向不符 | `Cursor is invalid or expired.` |
 * | 5 | 群组但调用者不是成员 | `Group not found.` |
 * | 6 | 私聊但调用者不是参与者 | `Channel not found.` |
 *
 * 另外三条容易错的默认值：limit 缺省是 **1**（不是 100）、forward 缺省 true、
 * 分页要**多取一行**来判断还有没有下一页。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_channel.go::ListChannelMessages
 * 契约源: server/core_channel.go::ChannelMessagesList
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/channel/{channelId}
 *
 * REQ-0001-010
 */

afterEach(closeAllWorlds);

interface MessageBody {
  readonly message_id: string;
  readonly channel_id: string;
  readonly code: number;
  readonly sender_id: string;
  readonly username: string;
  readonly content: string;
  readonly persistent: boolean;
  readonly room_name: string;
}

interface ListBody {
  readonly messages?: readonly MessageBody[];
  readonly next_cursor?: string;
  readonly prev_cursor?: string;
  readonly cacheable_cursor?: string;
}

async function history(world: Awaited<ReturnType<typeof channelWorld>>, channelId: string, query = "") {
  const response = await listChannelHistory(world, channelId, query);
  expect(response.status, `读历史失败：${response.status} ${await response.clone().text()}`).toBe(200);
  return (await response.json()) as ListBody;
}

/** 往房间里灌 n 条持久化消息（都是同一个发送者）。 */
async function seedMessages(
  world: Awaited<ReturnType<typeof channelWorld>>,
  room: string,
  count: number,
): Promise<string[]> {
  const alice = await world.open(sessionId("history-sender"), CALLER.id, CALLER.username);
  await joinRoom(alice, "a1", room);
  const ids: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    ids.push(await sendChannelMessage(alice, `m${index}`, roomChannelId(room), `{"n":${index}}`));
  }
  return ids;
}

/** 加入一个非房间频道（私聊/群组），返回服务端算出来的频道 id。 */
async function joinDirectMessage(target: TestSocket, cid: string): Promise<string> {
  sendFrame(target, channelJoinEnvelope(cid, PEER.id, 2));
  const reply = channelReply(
    await waitForFrame(target, (frame) => frame.cid === cid && frame.message.case === "channel"),
  );
  return reply.channelId;
}

describe("M4 契约: 频道历史", () => {
  it("test_a_persistent_message_is_read_back_with_the_full_wire_shape", async () => {
    const world = await channelWorld();
    const ids = await seedMessages(world, "room-history", 1);

    const body = await history(world, roomChannelId("room-history"));

    expect(body.messages).toHaveLength(1);
    const message = body.messages?.[0] as MessageBody;
    expect(message.message_id).toBe(ids[0]);
    expect(message.channel_id).toBe(roomChannelId("room-history"));
    expect(message.sender_id).toBe(CALLER.id);
    expect(message.username).toBe(CALLER.username);
    expect(message.content).toBe('{"n":1}');
    // 能出现在历史里的消息一定是持久化过的（上游这里恒为 true）。
    expect(message.persistent).toBe(true);
    // 包装类型 `code` 即使等于 0 也在线上（与裸 int32 的"零值省略"不同）。
    expect(message.code).toBe(0);
    // 房间频道带 room_name，不带 group_id / user_id_one。
    expect(message.room_name).toBe("room-history");
  });

  it("test_the_limit_defaults_to_one_message", async () => {
    const world = await channelWorld();
    await seedMessages(world, "room-default", 3);

    const body = await history(world, roomChannelId("room-default"));

    expect(body.messages).toHaveLength(1);
    expect(body.messages?.[0]?.content).toBe('{"n":1}');
    expect(body.next_cursor).toBeDefined();
  });

  it("test_forward_paging_walks_from_the_oldest_to_the_newest", async () => {
    const world = await channelWorld();
    await seedMessages(world, "room-forward", 3);
    const channelId = roomChannelId("room-forward");

    const first = await history(world, channelId, "?limit=2");
    expect(first.messages?.map((message) => message.content)).toEqual(['{"n":1}', '{"n":2}']);
    expect(first.next_cursor).toBeDefined();
    // 没带游标的请求不会产出"上一页"。
    expect(first.prev_cursor).toBeUndefined();

    const second = await history(world, channelId, `?limit=2&cursor=${first.next_cursor ?? ""}`);
    expect(second.messages?.map((message) => message.content)).toEqual(['{"n":3}']);
    // 带了游标 → 回翻是可能的，于是有 prev_cursor；最后一页没有 next_cursor。
    expect(second.prev_cursor).toBeDefined();
    expect(second.next_cursor).toBeUndefined();

    const back = await history(world, channelId, `?limit=2&cursor=${second.prev_cursor ?? ""}`);
    expect(back.messages?.map((message) => message.content)).toEqual(['{"n":1}', '{"n":2}']);
  });

  it("test_backward_paging_starts_from_the_newest_message", async () => {
    const world = await channelWorld();
    await seedMessages(world, "room-backward", 3);
    const channelId = roomChannelId("room-backward");

    const page = await history(world, channelId, "?limit=2&forward=false");

    expect(page.messages?.map((message) => message.content)).toEqual(['{"n":3}', '{"n":2}']);
    // 倒序翻页时"下一页"要往更旧的方向走。
    expect(page.next_cursor).toBeDefined();
    const older = await history(
      world,
      channelId,
      `?limit=2&forward=false&cursor=${page.next_cursor ?? ""}`,
    );
    expect(older.messages?.map((message) => message.content)).toEqual(['{"n":1}']);
  });

  it("test_a_cursor_from_another_channel_is_rejected", async () => {
    const world = await channelWorld();
    await seedMessages(world, "room-cursor-a", 2);
    const other = await seedMessages(world, "room-cursor-b", 2);
    expect(other).toHaveLength(2);
    const page = await history(world, roomChannelId("room-cursor-a"), "?limit=1");

    const response = await listChannelHistory(
      world,
      roomChannelId("room-cursor-b"),
      `?limit=1&cursor=${page.next_cursor ?? ""}`,
    );

    expect(response.status).toBe(400);
    expect(await errorBody(response)).toEqual({
      code: 3,
      message: "Cursor is invalid or expired.",
    });
  });

  it("test_a_cursor_for_the_other_direction_is_rejected", async () => {
    const world = await channelWorld();
    await seedMessages(world, "room-direction", 2);
    const channelId = roomChannelId("room-direction");
    const page = await history(world, channelId, "?limit=1");

    const response = await listChannelHistory(
      world,
      channelId,
      `?limit=1&forward=false&cursor=${page.next_cursor ?? ""}`,
    );

    expect(response.status).toBe(400);
    expect((await errorBody(response)).message).toBe("Cursor is invalid or expired.");
  });

  it("test_an_invalid_limit_is_rejected_with_the_upstream_message", async () => {
    const world = await channelWorld();
    const channelId = roomChannelId("room-limit");

    for (const limit of ["0", "101", "-1", "abc", "1.5"]) {
      const response = await listChannelHistory(world, channelId, `?limit=${limit}`);
      expect(response.status, limit).toBe(400);
      expect(await errorBody(response), limit).toEqual({
        code: 3,
        message: "Invalid limit - limit must be between 1 and 100.",
      });
    }
  });

  it("test_an_invalid_channel_identifier_is_rejected", async () => {
    const world = await channelWorld();

    for (const channelId of ["not-a-channel", "2..", `2...${"r".repeat(65)}`, `5...room-1`]) {
      const response = await listChannelHistory(world, channelId);
      expect(response.status, channelId).toBe(400);
      expect(await errorBody(response), channelId).toEqual({
        code: 3,
        message: "Invalid channel ID.",
      });
    }
  });

  it("test_a_room_is_readable_by_any_authenticated_user", async () => {
    const world = await channelWorld();
    await seedMessages(world, "room-public", 1);

    // `listChannelHistory` 每次都开一条**新的** REST 会话：这个账号从来没进过房间。
    const body = await history(world, roomChannelId("room-public"));

    expect(body.messages).toHaveLength(1);
  });

  it("test_a_direct_message_is_not_readable_by_an_outsider", async () => {
    const world = await channelWorld();
    const alice = await world.open(sessionId("dm-reader"), CALLER.id, CALLER.username);
    // 先把私聊频道建出来并放进一条消息：外人读不到不是因为"这个频道不存在"。
    const channelId = await joinDirectMessage(alice, "d1");
    await sendChannelMessage(alice, "m1", channelId, "{}");
    const outsider = await world.restSession();

    const response = await listChannelHistoryAs(
      outsider.token,
      directChannelId(CALLER.id, PEER.id),
    );

    expect(response.status).toBe(400);
    expect(await errorBody(response)).toEqual({ code: 3, message: "Channel not found." });
  });

  it("test_a_group_channel_is_reported_as_not_found", async () => {
    const world = await channelWorld();

    const response = await listChannelHistory(world, `3.${crypto.randomUUID().toUpperCase()}..`);

    expect(response.status).toBe(400);
    expect(await errorBody(response)).toEqual({ code: 3, message: "Group not found." });
  });

  it("test_an_unauthenticated_history_request_is_rejected", async () => {
    const world = await channelWorld();
    await seedMessages(world, "room-auth", 1);

    const response = await call(channelHistoryPath(roomChannelId("room-auth")));

    expect(response.status).toBe(401);
  });
});
