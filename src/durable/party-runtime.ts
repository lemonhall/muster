/**
 * 派对 DO 内部的共享上下文：一次派对操作要用到的全部协作者。
 *
 * 为什么要有这一层：派对的语义被拆成三个文件（`party-core.ts` 管生命周期、
 * `party-roster-ops.ts` 管批/踢/提拔、`party-frame-ops.ts` 管数据面），它们都要
 * "成员表 + 请求表 + 投递 + 租户/派对标识"。把这一束东西命名成 `PartyRuntime`，
 * 三个文件就都能拿到同一份引用，而不必各自再声明六个参数。
 *
 * `delivery` 由工厂在这里构造：它需要成员表与请求表，而两者在构造 `PartyCore`
 * 时就绪了，所以只有工厂知道这层装配顺序。
 *
 * 契约源（机器可读）：
 * 契约源: server/party_handler.go::PartyHandler
 *
 * REQ-0001-019
 */

import type { Bindings } from "../env";
import { formatPartyId, LOCAL_NODE } from "../domain/party/ids";
import { fail } from "./party-op";
import { PartyDelivery } from "./party-delivery";
import type { PartyMembers } from "./party-members";
import type { PartyRequests } from "./party-requests";
import type { PartyOpResult } from "../realtime/party";

export interface PartyRuntime {
  readonly env: Bindings;
  readonly tenantId: string;
  readonly uuid: string;
  /** 对外的派对 id：`<uuid>.muster`。 */
  readonly partyId: string;
  readonly members: PartyMembers;
  readonly requests: PartyRequests;
  readonly delivery: PartyDelivery;
  readonly now: () => number;
}

export function createPartyRuntime(
  env: Bindings,
  tenantId: string,
  uuid: string,
  members: PartyMembers,
  requests: PartyRequests,
  now: () => number = () => Date.now(),
): PartyRuntime {
  const partyId = formatPartyId(uuid, LOCAL_NODE);
  return {
    env,
    tenantId,
    uuid,
    partyId,
    members,
    requests,
    delivery: new PartyDelivery(env, tenantId, partyId, members, requests),
    now,
  };
}

/**
 * 上游 `LocalPartyRegistry` 每个方法开头的那道节点校验：派对 id 的 node 段
 * 必须等于本节点，否则一律 `party not found`。
 *
 * 本项目的"节点"只有一个（`muster`，ECN-0011 偏差 6），于是这条校验退化成
 * "id 的 node 段必须是 muster"；它仍然必要——客户端完全可以编出一个
 * `<uuid>.某个不存在的节点`，上游对这种 id 报的就是 `party not found`。
 */
export function nodeGuard(runtime: PartyRuntime, node: string): PartyOpResult | null {
  void runtime;
  if (node === LOCAL_NODE) return null;
  return fail("not-found");
}

/**
 * 队长的唯一判据：**会话 id 相同 + 节点相同**（上游
 * `p.leader.UserPresence.SessionId != sessionID || p.leader.PresenceID.Node != node`）。
 *
 * 注意这里比的是"调用方给的节点"（派对 id 的 node 段），不是 leader presence 自己的
 * 节点——上游就是这么写的，两者在派对由本节点创建时恒等。
 */
export function leaderOnly(runtime: PartyRuntime, sessionId: string, node: string): PartyOpResult | null {
  if (runtime.members.meta() === null) return fail("not-found");
  const leader = runtime.members.leader();
  if (leader === null || leader.sessionId !== sessionId || leader.node !== node) {
    return fail("not-leader");
  }
  return null;
}
