/**
 * 好友端点的线格式（protojson + `UseProtoNames`）。
 *
 * 三条容易写错的规则，都从上游 proto 定义推导而来（不是本项目的口味）：
 *   1. `state` 在 proto 里是 `google.protobuf.Int32Value`（**包装类型**），protojson
 *      把它序列化成**裸数字**而不是 `{"value":N}`。包装类型本身存在，所以 `state: 0`
 *      照样输出——这一点与"普通 int32 的 0 被省略"不同；
 *   2. `update_time` 是 `Timestamp`，永远存在；REST 面是 RFC3339；
 *   3. 空 repeated 字段整体省略，所以"没有好友"是 `{}` 而不是 `{"friends":[]}`。
 *
 * 契约源（机器可读）：
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/friend
 * 契约源: server/core_friend.go::ListFriends
 * 契约源: server/core_friend.go::ListFriendsOfFriends
 *
 * REQ-0001-011
 */

import type { FriendRow } from "../domain/friends/types";
import type { FriendListResult, FriendsOfFriendsResult } from "../domain/friends/service";
import { formatTimestamp, userBody } from "./identity";

export function friendBody(row: FriendRow, online: boolean): Record<string, unknown> {
  return {
    user: userBody(row, online),
    state: row.state,
    update_time: formatTimestamp(row.edge_update_time),
    ...(row.edge_metadata === "" ? {} : { metadata: row.edge_metadata }),
  };
}

export function friendListBody(
  result: FriendListResult,
  onlineIds: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  return {
    ...(result.friends.length === 0
      ? {}
      : { friends: result.friends.map((row) => friendBody(row, onlineIds.has(row.id))) }),
    ...(result.cursor === "" ? {} : { cursor: result.cursor }),
  };
}

/**
 * 好友的好友。
 *
 * `user` 上游走 `GetUsers`，所以它是**完整**的用户对象（含 online 填充）；
 * `referrer` 是"通过谁认识的"。
 */
export function friendsOfFriendsBody(
  result: FriendsOfFriendsResult,
  onlineIds: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  return {
    ...(result.friendsOfFriends.length === 0
      ? {}
      : {
          friends_of_friends: result.friendsOfFriends.map((entry) => ({
            referrer: entry.referrer,
            user: userBody(entry.user, onlineIds.has(entry.user.id)),
          })),
        }),
    ...(result.cursor === "" ? {} : { cursor: result.cursor }),
  };
}
