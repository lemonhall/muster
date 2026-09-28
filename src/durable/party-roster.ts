/**
 * 派对成员快照与投递：把成员表的行变成 `PartyPresence`，再把一帧发给其中一部分人。
 *
 * 与 `match-roster.ts` 同一套路：这一层只认"成员表 + 收件人集合 + 一帧"，
 * 语义在 `party-core.ts`。投递是唯一会碰网络的地方，单独放一层，
 * "哪些动作会出网"在文件级别就是可见的。
 *
 * 投递用 `allSettled`：一个成员的连接挂掉不该拖住（或挡住）其他人的那一帧。
 * 失败只记日志——上游 `tracker.SendToStream` 找不到某个流时同样是跳过。
 *
 * 契约源（机器可读）：
 * 契约源: server/tracker.go::LocalTracker.SendToStream
 *
 * REQ-0001-019
 */

import type { Bindings } from "../env";
import type { PartyMemberEntry, PartyPresence } from "../domain/party/types";
import type { Envelope } from "../proto/realtime_pb";
import { deliverToSession } from "./delivery";

/** 真成员的 presence 列表（预留位不是成员）。顺序 = 进入顺序。 */
export function partyPresences(entries: readonly PartyMemberEntry[]): readonly PartyPresence[] {
  const presences: PartyPresence[] = [];
  for (const entry of entries) if (!entry.reserved) presences.push(entry.presence);
  return presences;
}

export async function partyDeliverTo(
  env: Bindings,
  tenantId: string,
  targets: readonly PartyPresence[],
  frame: Envelope,
): Promise<void> {
  if (targets.length === 0) return;
  const results = await Promise.allSettled(
    targets.map((presence) => deliverToSession(env, tenantId, presence.sessionId, frame)),
  );
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error(`投递派对帧到会话 ${targets[index]?.sessionId ?? "(未知)"} 失败`, result.reason);
    }
  }
}
