/**
 * 通知的**类别码**：上游 `core_notification.go` 顶部那组常量。
 *
 * 负数是系统保留的（客户端按 `code` 决定本地化文案与"点开做什么"），所以这九个数字
 * 是线上契约的一部分，不能重排。它们出现在好友、群组、私聊三条路径上，所以常量放在
 * 通知域里（而不是某个业务域里），由各业务域引用。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_notification.go::NotificationCodeDmRequest
 *
 * REQ-0001-013
 */

export const NOTIFICATION_CODE = {
  /** 私聊请求：`<username> wants to chat`。 */
  dmRequest: -1,
  /** 好友请求：`<username> wants to add you as a friend`。 */
  friendRequest: -2,
  /** 好友请求被接受：`<username> accepted your friend request`。 */
  friendAccept: -3,
  /** 被加进群组：`You've been added to group <name>`。 */
  groupAdd: -4,
  /** 有人申请加入你管理的群组：`User <username> wants to join your group`。 */
  groupJoinRequest: -5,
  /** 好友开局（M7 匹配/对局落地时使用）。 */
  friendJoinGame: -6,
  /** 单 socket（M6 之后按需使用）。 */
  singleSocket: -7,
  /** 账号被封禁。 */
  userBanned: -8,
  /** 被解除好友：`<username> removed you as a friend`。 */
  friendRemove: -9,
} as const;
