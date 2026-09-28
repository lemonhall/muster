/**
 * 控制台用户的两条**授权规则**，逐字对齐上游 `server/console_user.go`。
 *
 * 这两条规则为什么单独成文件、而不是塞进端点里：它们是"谁来授权谁"的全部答案，
 * 而且两条的**失败码不同**——
 *   - 建用户时超权 → `InvalidArgument`（上游把"你写错了"归给请求方）；
 *   - 重置密码时目标超权 → `PermissionDenied`（上游把"你不该动这条记录"归给授权）。
 * 混成一个码在客户端看来就是"同一种失败"，而它们要引导用户做完全不同的事。
 *
 * 文案是**逐字**的：上游客户端按这两个字符串做分支判断。
 *
 * 契约源（机器可读）：
 * 契约源: server/console_user.go::validateConsoleUserACLGrant
 * 契约源: server/console_user.go::validateConsoleUserTargetACL
 *
 * REQ-0001-021
 */

import { invalidArgument, permissionDenied } from "../../../http/errors";
import { hasAccess, isNone, type Permission } from "../acl/permission";

export const ACL_GRANT_EMPTY = "User must have at least some permissions.";
export const ACL_GRANT_TOO_WIDE =
  "Cannot create users with more permissions than the current session.";
export const ACL_TARGET_TOO_WIDE =
  "Cannot reset the password of a user with permissions outside the current session.";

/**
 * 上游 `validateConsoleUserACLGrant`：先看空权限，再看"是否超出自己"。
 *
 * 顺序不能反：空权限一定也"超出自己"（除非自己也是空），先判空才能给出
 * "你至少得给一个权限"这条更有用的提示。
 */
export function validateConsoleUserACLGrant(
  creatorRole: Permission,
  requestedRole: Permission,
): void {
  if (isNone(requestedRole)) throw invalidArgument(ACL_GRANT_EMPTY);
  if (!hasAccess(creatorRole, requestedRole)) throw invalidArgument(ACL_GRANT_TOO_WIDE);
}

/** 上游 `validateConsoleUserTargetACL`：调用者必须能覆盖目标的全部权限位。 */
export function validateConsoleUserTargetACL(callerRole: Permission, targetRole: Permission): void {
  if (!hasAccess(callerRole, targetRole)) throw permissionDenied(ACL_TARGET_TOO_WIDE);
}
