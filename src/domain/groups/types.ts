/**
 * 群组域的取值与行形状。
 *
 * 两组状态机**不能混为一谈**，它们的数字都直接来自上游 proto（客户端读这些数字）：
 *
 *   群组本身（`groups.state`）：0 开放 / 1 私有。
 *     ——注意库里那一列叫 `open`（布尔），是它的取反。上游存的是 `state`，
 *     查询用 `state = $n`；本项目存布尔只是把"0 开放 / 1 私有"折成一位，
 *     转换只发生在 SQL 边界（`store.ts` 的 `stateOf(open)`）。
 *
 *   成员关系（`group_edge.state`）：0 SUPERADMIN / 1 ADMIN / 2 MEMBER /
 *     3 JOIN_REQUEST / 4 BANNED。权限判定一律是"**数值越小权限越大**"
 *     （`dbState <= state`），所以"是不是管理员"写成 `state <= 1`。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_group.go::groupCheckUserPermission
 * 契约源: server/core_group.go::CreateGroup
 * 契约源: vendor/github.com/heroiclabs/nakama-common/api/api.pb.go::GroupUserList_GroupUser_State
 *
 * REQ-0001-012
 */

/** `groups.state`：开放（任何人可加入）与私有（需要管理员批准）。 */
export const GROUP_STATE = {
  open: 0,
  closed: 1,
} as const;

/** `group_edge.state`：权限随数字**减小**而增大。 */
export const GROUP_ROLE = {
  superadmin: 0,
  admin: 1,
  member: 2,
  joinRequest: 3,
  banned: 4,
} as const;

/**
 * 能管人的两条角色（上游所有"改群"操作的前置都是 `dbState > 1 → 拒绝`，
 * 也就是要求 `state <= 1`）。名字取"权限位"而不是"枚举名"，因为调用点读的是
 * "这个操作至少要什么权限"。
 */
export const GROUP_MANAGE_ROLE = GROUP_ROLE.admin;

/** 建群时的默认上限（上游 `ApiServer.CreateGroup` 里那句 `maxCount := 100`）。 */
export const DEFAULT_GROUP_MAX_COUNT = 100;

/**
 * 群组操作的调用者。`username` 不是装饰：群频道事件与通知的文案里都有它
 * （上游从上下文里取 `ctxUsernameKey`，本项目从会话里取）。
 */
export interface GroupCaller {
  readonly id: string;
  readonly username: string;
}

/** `groups` 表的一行。 */
export interface GroupRow {
  readonly id: string;
  readonly creator_id: string;
  readonly name: string;
  readonly description: string;
  readonly avatar_url: string;
  readonly lang_tag: string;
  readonly metadata: string;
  /** 0 开放 / 1 私有（库里的布尔列在这里已经换算回上游的 `state`）。 */
  readonly state: number;
  readonly edge_count: number;
  readonly max_count: number;
  readonly create_time: number;
  readonly update_time: number;
}

/** 群成员列表的一行：用户资料 + 他在这群里的角色。 */
export interface GroupUserRow {
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
}

/** 用户群组列表的一行：群本身 + 我在群里的角色 + 我的那条边的定位。 */
export interface UserGroupRow {
  readonly id: string;
  readonly creator_id: string;
  readonly name: string;
  readonly description: string;
  readonly avatar_url: string;
  readonly lang_tag: string;
  readonly metadata: string;
  readonly state: number;
  readonly edge_count: number;
  readonly max_count: number;
  readonly create_time: number;
  readonly update_time: number;
  readonly user_state: number;
  readonly position: number;
}

/** 成员列表与用户群组列表共用的游标：按 `(state, position)` 定位（上游 `edgeListCursor`）。 */
export interface EdgeCursor {
  readonly state: number;
  readonly position: number;
}

/**
 * 群组列表的游标（上游 `groupListCursor`）。
 *
 * 上游存的是**纳秒** `UpdateTime`，本项目换成秒（理由与 ECN-0008 里 position 的同类
 * 偏差一致：纳秒超出 JS 安全整数范围，进游标会静默丢精度）。九条排序分支各自只用到
 * 其中一部分字段，所以除 `id` 外全部可选。
 */
export interface GroupListCursor {
  readonly id: string;
  readonly name: string;
  readonly langTag: string;
  readonly edgeCount: number;
  readonly open: boolean;
  readonly updateTime: number;
}
