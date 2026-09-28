/**
 * 群成员管理五条操作的**共同前置**。
 *
 * 单独成文件是因为它是"这五个端点为什么长得一样"的答案，而不是其中任何一条的实现。
 * 三条纪律：
 *
 * 1. **群不存在与没权限回同一句话**（`Group not found or permission denied.`）。
 *    上游刻意不区分——"你没有这条边"在两种情况下是同一条事实，告诉调用者
 *    "这个群确实存在只是你不够格"会泄露群的存在性；
 * 2. **目标用户先去重、再剔除调用者自己**：上游用 map 记下 userIds 并
 *    `if uid == caller { continue }`，所以"把自己加进群"是静默成功的空操作；
 * 3. **先整体校验目标账号是否存在**（`One or more users not found.`）。
 *    上游这一句会让整个事务回滚，所以本项目也必须"一个不存在就谁都别动"，
 *    而不是"跳过不存在的那个人继续"。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_group.go::AddGroupUsers
 * 契约源: server/core_group.go::BanGroupUsers
 * 契约源: server/core_group.go::KickGroupUsers
 *
 * REQ-0001-012
 */

import { invalidArgument, notFound } from "../../http/errors";
import type { Bindings } from "../../env";
import { findEdgeState, findUsernames } from "./store";
import { GROUP_MANAGE_ROLE } from "./types";

export const DENIED = "Group not found or permission denied.";

/**
 * 调用者是否是管理员（`state <= 1`）；不是就抛出上游那句拒绝。
 *
 * 群不存在时这里查不到边 → 同样落到这句拒绝，与上游的 `ErrGroupPermissionDenied` 一致。
 * 返回调用者的角色：踢人与封禁需要它来决定"能不能动 superadmin"。
 */
export async function requireManager(
  env: Bindings,
  tenantId: string,
  groupId: string,
  callerId: string,
): Promise<number> {
  const state = await findEdgeState(env.DB, tenantId, groupId, callerId);
  if (state === null || state > GROUP_MANAGE_ROLE) throw notFound(DENIED);
  return state;
}

/** 去掉调用者自己与重复项（上游用 map 去重，并 `if uid == caller { continue }`）。 */
export function uniqueTargets(ids: readonly string[], callerId: string): string[] {
  return [...new Set(ids)].filter((id) => id !== callerId);
}

/** 先整体校验目标账号是否存在：这句错误在上游会让整个事务回滚。 */
export async function requireExistingUsers(
  env: Bindings,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const found = await findUsernames(env.DB, tenantId, ids);
  if (found.size !== ids.length) throw invalidArgument("One or more users not found.");
  return found;
}
