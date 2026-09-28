/**
 * 群组频道的进入条件。
 *
 * 上游的规则是"调用者必须是该群组的成员（权限位 ≥ 2）"：
 * `groupCheckUserPermission(ctx, logger, db, stream.Subject, caller, 2)`；群组不存在
 * 或调用者不是成员，返回的都是"不允许"，调用方据此回
 * `Group not found: Invalid channel target`（`BAD_INPUT`）。
 *
 * v1 **还没有群组数据模型**（群组的建立/成员/权限属于后续里程碑），所以这里的能力
 * 如实返回"不允许"——这与上游面对一个**不存在的群组**时的行为**完全一致**，
 * 而不是"我们暂时放行"或"我们直接报未实现"。
 *
 * 换个说法：M4 要证明的是"三类频道的判定入口都存在且语义正确"，群组这一类在
 * 没有群组数据的前提下唯一可观测的正确行为就是拒绝。群组数据模型落地后，这里换成
 * 真正的成员查询即可，**调用点与错误文案都不用动**。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_channel.go::BuildChannelId
 *
 * REQ-0001-010
 */

export async function canAccessGroup(
  db: D1Database,
  tenantId: string,
  groupId: string,
  userId: string,
): Promise<boolean> {
  void db;
  void tenantId;
  void groupId;
  void userId;
  return false;
}
