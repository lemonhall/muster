/**
 * 群组端点对 id 参数的校验与规范化。
 *
 * 上游用两把不同的尺子，而且**故意**保留了这个差异（照抄，不要"顺手统一"）：
 *   - `groupId` 走 `uuid.FromString`：解析失败才报错，全零 UUID 是合法输入
 *     （它随后查不到任何群，于是落到"群不存在"那条业务错误上）；
 *   - `userIds` 走 `uuid.FromStringOrNil` + `uid == uuid.Nil` 判断：解析失败与**全零
 *     UUID 都会**被报成 `User ID must be a valid ID.`。
 *
 * `GetUserGroups` 还有一处上游复制粘贴 bug：`userId` 不合法时报的是
 * `Group ID must be a valid ID.`。那句文案是客户端能看到的输出，按塔山循环的原则
 * 照抄（登记在 ECR/审查记录里，不改）。
 *
 * 解析用 `realtime/identifiers.ts` 那套（接受带/不带连字符、`urn:uuid:`、花括号），
 * 与本项目"入口统一大写标准形"的既有约定一致。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_group.go::ListUserGroups
 * 契约源: server/api_group.go::AddGroupUsers
 *
 * REQ-0001-012
 */

import { invalidArgument } from "../../http/errors";
import { normalizeUserId } from "../../realtime/identifiers";

/** 上游 `uuid.Nil` 的文本形（本项目所有 id 都是大写标准形）。 */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

function parse(raw: string): string | null {
  return normalizeUserId(raw);
}

/** 路径/表单里的 `groupId`：先空、后非法（两句文案不同）。 */
export function requireGroupId(raw: string): string {
  if (raw === "") throw invalidArgument("Group ID must be set.");
  const id = parse(raw);
  if (id === null) throw invalidArgument("Group ID must be a valid ID.");
  return id;
}

/**
 * `ListUserGroups` 的 `userId`：空时报"User ID must be set."，非法时报
 * "Group ID must be a valid ID."（上游复制粘贴 bug，原样保留）。
 */
export function requireUserGroupOwnerId(raw: string): string {
  if (raw === "") throw invalidArgument("User ID must be set.");
  const id = parse(raw);
  if (id === null) throw invalidArgument("Group ID must be a valid ID.");
  return id;
}

/** `userIds` 里的每个元素：非法与全零都报同一句（上游 `FromStringOrNil` 的语义）。 */
export function requireUserId(raw: string): string {
  const id = parse(raw);
  if (id === null || id === NIL_UUID) throw invalidArgument("User ID must be a valid ID.");
  return id;
}
