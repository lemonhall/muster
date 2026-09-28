import { describe, expect, it } from "vitest";

import {
  buildChannelId,
  channelIdToStream,
  streamToChannelId,
} from "../../../src/realtime/channel-ids";
import { CALLER_ID, PEER_ID } from "../../helpers/realtime";

/**
 * M4 契约：频道标识符（`2.<label>` 房间 / `3.<gid>` 群组 / `4.<one>.<two>` 私聊）。
 *
 * 上游把频道 id 当作**纯字符串**在客户端与服务端之间传递，所以它的构造与解析
 * 本身就是对外契约：形状不对就不是"另一个频道"，而是 `BAD_INPUT` + 关闭连接。
 *
 * 契约源: server/core_channel.go::BuildChannelId
 * 契约源: server/core_channel.go::ChannelIdToStream
 * 契约源: server/core_channel.go::StreamToChannelId
 * 契约源: server/tracker.go::StreamModeChannel
 *
 * REQ-0001-010
 */

/** `ChannelJoin.Type` 的枚举值（proto 里的数字，不是 stream mode）。 */
const ROOM = 1;
const DIRECT = 2;
const GROUP = 3;
const UNSPECIFIED = 0;

describe("M4 契约: 频道标识符", () => {
  it("test_build_room_channel_id", () => {
    const built = buildChannelId(CALLER_ID, "room-1", ROOM);
    expect(built).toEqual({
      ok: true,
      channelId: "2...room-1",
      stream: { mode: 2, subject: "", subcontext: "", label: "room-1" },
    });
  });

  it("test_unspecified_channel_type_defaults_to_room", () => {
    // 上游 `BuildChannelId` 里 `TYPE_UNSPECIFIED` 与 `ROOM` 走同一个 fallthrough 分支。
    const built = buildChannelId(CALLER_ID, "room-1", UNSPECIFIED);
    expect(built.ok && built.stream.mode).toBe(2);
    expect(built.ok && built.channelId).toBe("2...room-1");
  });

  it("test_room_name_may_be_64_bytes_but_not_65", () => {
    const sixtyFour = "r".repeat(64);
    expect(buildChannelId(CALLER_ID, sixtyFour, ROOM).ok).toBe(true);
    expect(buildChannelId(CALLER_ID, "r".repeat(65), ROOM)).toEqual({
      ok: false,
      message: "Channel name is required and must be 1-64 chars: Invalid channel target",
    });
  });

  it("test_room_name_limit_is_bytes_not_characters", () => {
    // 上游用的是 Go 的 `len(target)`，单位是**字节**：21 个汉字 = 63 字节可以，
    // 22 个汉字 = 66 字节就被拒。写成"字符数"会在这里露馅。
    expect(buildChannelId(CALLER_ID, "甲".repeat(21), ROOM).ok).toBe(true);
    expect(buildChannelId(CALLER_ID, "甲".repeat(22), ROOM).ok).toBe(false);
  });

  it("test_empty_room_name_is_rejected", () => {
    expect(buildChannelId(CALLER_ID, "", ROOM)).toEqual({
      ok: false,
      message: "Invalid channel target",
    });
  });

  it("test_room_name_rejects_control_characters", () => {
    expect(buildChannelId(CALLER_ID, "room\u0001name", ROOM)).toEqual({
      ok: false,
      message: "Channel name must not contain control chars: Invalid channel target",
    });
    expect(buildChannelId(CALLER_ID, "room\u007fname", ROOM).ok).toBe(false);
  });

  it("test_group_channel_requires_a_group_identifier", () => {
    expect(buildChannelId(CALLER_ID, "not-a-uuid", GROUP)).toEqual({
      ok: false,
      message: "Invalid group ID in group channel join: Invalid channel target",
    });
  });

  it("test_unknown_channel_type_is_rejected", () => {
    expect(buildChannelId(CALLER_ID, "room-1", 9)).toEqual({
      ok: false,
      message: "Invalid channel type",
    });
  });

  it("test_direct_message_channel_pairs_users_in_a_stable_order", () => {
    const forward = buildChannelId(CALLER_ID, PEER_ID, DIRECT);
    const backward = buildChannelId(PEER_ID, CALLER_ID, DIRECT);
    expect(forward.ok).toBe(true);
    expect(backward.ok).toBe(true);
    expect(forward.ok && forward.channelId).toBe(backward.ok ? backward.channelId : "");
    // 两侧都必须落在同一个 stream 上，否则"同一个私聊"会被拆成两条互不可见的会话。
    expect(forward.ok && forward.stream.subject).toBe(backward.ok ? backward.stream.subject : "");
  });

  it("test_direct_message_rejects_a_malformed_user_identifier", () => {
    expect(buildChannelId(CALLER_ID, "nope", DIRECT)).toEqual({
      ok: false,
      message: "Invalid user ID in direct message join: Invalid channel target",
    });
  });

  it("test_channel_id_parses_back_to_the_same_stream", () => {
    // 注意 `2...room-1.extra`：上游用 `SplitN(id, ".", 4)`，第四段可以含点，
    // 所以"房间名里带点"是合法的，且能原样往返。
    for (const id of ["2...room-1", "2...room-1.extra", `3.${PEER_ID}..`, `4.${CALLER_ID}.${PEER_ID}.`]) {
      const stream = channelIdToStream(id);
      expect(stream, id).not.toBeNull();
      expect(streamToChannelId(stream!)).toBe(id);
    }
  });

  it("test_channel_id_parsing_canonicalises_uuid_case", () => {
    // 客户端可能把 id 写成小写；同一个私聊必须落到同一个 stream 上（否则消息发不进去）。
    const stream = channelIdToStream(`4.${CALLER_ID.toLowerCase()}.${PEER_ID.toLowerCase()}.`);
    expect(streamToChannelId(stream!)).toBe(`4.${CALLER_ID}.${PEER_ID}.`);
  });

  it("test_malformed_channel_ids_are_rejected", () => {
    const bad = [
      "",
      "2..",
      "2...",
      "5...room-1",
      "2.abc..room-1",
      `3.not-a-uuid..`,
      `3.${PEER_ID}..label`,
      `4.${CALLER_ID}.${PEER_ID}.label`,
      `4.${CALLER_ID}.nope.`,
      `4.${CALLER_ID}.${PEER_ID}`, // 只有三段
      `2...${"r".repeat(65)}`,
    ];
    for (const id of bad) expect(channelIdToStream(id), id).toBeNull();
  });

  it("test_channel_id_parsing_is_more_permissive_than_channel_creation", () => {
    // 上游的两半宽严不同，这里照抄：`ChannelIdToStream` 对房间名只查 1..64 字节，
    // 而 `BuildChannelId` 才查控制字符与 UTF-8。所以"解析得过"不代表"能建出这个频道"。
    expect(channelIdToStream("2...\u0001")).not.toBeNull();
    expect(buildChannelId(CALLER_ID, "a\u0001b", 1).ok).toBe(false);
  });
});
