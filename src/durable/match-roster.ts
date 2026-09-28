/**
 * 对局成员快照与投递：把 SQL 里的一行行成员变成 `MatchPresence`，再把一帧发给其中一部分人。
 *
 * 这一层只认"成员表 + 收件人集合 + 一帧"，不认权威/中继的区别，也不认过滤器——
 * 那些是 `match-core.ts` 的语义。分开的好处是：投递是**唯一会碰网络**的地方，
 * 把它单独放在这里，"哪些动作会出网"在文件级别就是可见的。
 *
 * 投递用 `allSettled` 而不是顺序 await：一个成员的连接挂掉不该拖住（或挡住）其他人的
 * 那一帧。失败只记日志，因为上游对兄弟会话的投递失败同样是忽略
 * （`tracker.SendToStream` 找不到流就跳过）。
 *
 * 契约源（机器可读）：
 * 契约源: server/match_presence.go::MatchPresenceList.ListPresences
 *
 * REQ-0001-018
 */

import type { Bindings } from "../env";
import type { MatchPresence } from "../domain/match/presence";
import type { Envelope } from "../proto/realtime_pb";
import { deliverToSession } from "./delivery";
import type { MatchMemberRow, MatchMembers } from "./match-members";

/** 投递给会话的那一帧。取 `deliverToSession` 的第四个参数，签名变了这里跟着变。 */
export type MatchFrame = Envelope;

export function presenceOf(
  sessionId: string,
  userId: string,
  username: string,
  node: string,
): MatchPresence {
  return { node, userId, sessionId, username };
}

/** 成员表的快照：先来后到，同一毫秒内按会话 id（顺序稳定，不随存储层抖动）。 */
export function presencesOf(members: MatchMembers): readonly MatchPresence[] {
  return members
    .list()
    .map((row: MatchMemberRow) => presenceOf(row.session_id, row.user_id, row.username, row.node));
}

export async function deliverTo(
  env: Bindings,
  tenantId: string,
  targets: readonly MatchPresence[],
  frame: MatchFrame,
): Promise<void> {
  if (targets.length === 0) return;
  const results = await Promise.allSettled(
    targets.map((presence) => deliverToSession(env, tenantId, presence.sessionId, frame)),
  );
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error(`投递到会话 ${targets[index]?.sessionId ?? "(未知)"} 失败`, result.reason);
    }
  }
}

/** 广播给"除了某条会话之外"的全部成员（上游 `SendToStream` 减去发起者）。 */
export async function broadcastTo(
  env: Bindings,
  tenantId: string,
  targets: readonly MatchPresence[],
  exceptSessionId: string,
  frame: MatchFrame,
): Promise<void> {
  await deliverTo(
    env,
    tenantId,
    targets.filter((presence) => presence.sessionId !== exceptSessionId),
    frame,
  );
}
