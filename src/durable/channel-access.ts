/**
 * 读频道历史前的准入判定（上游 `ChannelMessagesList` 里"查权限"的那一段）。
 *
 * 判定本身很简单，值钱的是**它在这一步**：上游的顺序是
 * "解游标 → 查权限 → 查 SQL"，所以"游标坏了"会盖过"你没权限"，
 * 而"你没权限"又盖过"频道里没消息"。这个顺序是可观测契约（客户端拿到哪条错误），
 * 所以准入判定与游标校验放在同一个函数链里，而不是各自散在 REST 层与 DO 里。
 *
 * 三条分支与上游一一对应：
 * - 群组：`caller` 必须是成员（权限位 ≥ 2）。本项目 v1 没有群组数据模型，
 *   `canAccessGroup` 如实返回 false → 等价于上游的"群组不存在"。
 * - 私聊：`caller` 必须是两个参与者之一（频道 id 的 subject/subcontext 就是这两个人）。
 * - 房间（以及未知模式）：**不做判定**，任何登录用户都能读（上游的 fallthrough）。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_channel.go::ChannelMessagesList
 *
 * REQ-0001-010
 */

import { canAccessGroup } from "../domain/groups/access";
import type { Bindings } from "../env";
import type { ChannelStream } from "../realtime/channel-ids";

/** 三种拒绝理由；`null` 表示放行。REST 层按它选错误文案。 */
export type ChannelReadDenial = "group" | "channel";

export async function checkChannelReadAccess(
  env: Bindings,
  tenantId: string,
  stream: ChannelStream,
  callerId: string,
): Promise<ChannelReadDenial | null> {
  if (stream.mode === 3) {
    const allowed = await canAccessGroup(env.DB, tenantId, stream.subject, callerId);
    return allowed ? null : "group";
  }
  if (stream.mode === 4) {
    return stream.subject === callerId || stream.subcontext === callerId ? null : "channel";
  }
  return null;
}
