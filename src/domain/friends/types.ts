/**
 * 好友域的取值与行形状。
 *
 * `FRIEND_STATE` 的数值就是上游 `api.Friend.State` 的枚举值（客户端直接读这个数字），
 * 不允许"顺手重编号"：
 *   0 FRIEND / 1 INVITE_SENT / 2 INVITE_RECEIVED / 3 BLOCKED。
 *
 * `INVITE_SENT` 与 `INVITE_RECEIVED` 是**同一条关系**在两个方向上的两种视角：
 * A 加 B 会在库里写两行——A 的视角 `SENT`、B 的视角 `RECEIVED`（上游 `addFriend`）。
 * 所以 `GET /v2/friend` 的结果是"我看到的那些边"，而不是"全部边的一半"。
 *
 * 契约源（机器可读）：
 * 契约源: vendor/github.com/heroiclabs/nakama-common/api/api.pb.go::Friend_State
 * 契约源: server/core_friend.go::addFriend
 *
 * REQ-0001-011
 */

export const FRIEND_STATE = {
  friend: 0,
  inviteSent: 1,
  inviteReceived: 2,
  blocked: 3,
} as const;

/**
 * 通知类别码。权威定义在通知域（`domain/notifications/codes.ts`：它同时服务好友、
 * 群组、私聊三条路径），这里只是让好友域按老习惯从自己的 `types.ts` 取用。
 */
export { NOTIFICATION_CODE } from "../notifications/codes";

/** 一个用户的好友列表里的一行：好友的用户资料 + 边本身的状态。 */
export interface FriendRow {
  readonly id: string;
  readonly username: string;
  readonly display_name: string;
  readonly avatar_url: string;
  readonly lang_tag: string;
  readonly location: string;
  readonly timezone: string;
  readonly metadata: string;
  readonly create_time: number;
  readonly update_time: number;
  readonly state: number;
  readonly position: number;
  readonly edge_update_time: number;
  readonly edge_metadata: string;
}

/** 好友的好友：`referrer` 是"通过谁认识的"，`user` 是被推荐的人的资料。 */
export interface FriendsOfFriendsPair {
  readonly referrer: string;
  readonly friendId: string;
}

export interface UserProfileRow {
  readonly id: string;
  readonly username: string;
  readonly display_name: string;
  readonly avatar_url: string;
  readonly lang_tag: string;
  readonly location: string;
  readonly timezone: string;
  readonly metadata: string;
  readonly create_time: number;
  readonly update_time: number;
}

/** 上游 `core_friend.go` 里 `edgeListCursor` 的等价物：按 (state, position) 定位。 */
export interface EdgeCursor {
  readonly state: number;
  readonly position: number;
}

/** 上游 `friendsOfFriendsListCursor` 的等价物：按 (source, destination) 定位。 */
export interface FriendsOfFriendsCursor {
  readonly sourceId: string;
  readonly destinationId: string;
}
