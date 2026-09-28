/**
 * 群组频道的进入条件。
 *
 * 上游的规则是"调用者必须是该群组的成员（权限位 ≥ 2）"：
 * `groupCheckUserPermission(ctx, logger, db, stream.Subject, caller, 2)`；群组不存在
 * 或调用者不是成员，返回的都是"不允许"，调用方据此回
 * `Group not found: Invalid channel target`（`BAD_INPUT`）。
 *
 * v1 里这条路一定返回 false（群组数据模型还没落地）；M5 群组域落地后换成真查询——
 * 正如当初写下的那句话："调用点与错误文案都不用动"。
 *
 * "权限位 ≥ 2"就是 `state <= 2`：SUPERADMIN(0) / ADMIN(1) / MEMBER(2) 都能进，
 * JOIN_REQUEST(3) 与 BANNED(4) 不能。注意判据是**群 → 用户**那一行（`source_id = group`），
 * 与 `groupCheckUserPermission` 取的是同一行（双向边的另一半在"用户群组列表"那一侧用）。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_channel.go::BuildChannelId
 * 契约源: server/core_group.go::groupCheckUserPermission
 *
 * REQ-0001-010
 */

import { GROUP_ROLE } from "./types";

export async function canAccessGroup(
  db: D1Database,
  tenantId: string,
  groupId: string,
  userId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT state FROM group_edge
       WHERE tenant_id = ?1 AND source_id = ?2 AND destination_id = ?3`,
    )
    .bind(tenantId, groupId, userId)
    .first<{ state: number }>();
  return row !== null && row.state <= GROUP_ROLE.member;
}
