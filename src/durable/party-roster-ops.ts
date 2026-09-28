/**
 * 派对的"人员编排"：提拔队长、批准加入请求、踢人、关派对、列请求。
 *
 * 逐条对齐上游 `server/party_handler.go` 的这五个方法，校验顺序就是契约：
 *
 * | 动作 | 顺序 |
 * |---|---|
 * | promote | 节点 → 存在 → 队长 → 目标必须是成员（三件套） |
 * | accept | 节点 → 存在 → 队长 → 满员 → 请求必须在表里 |
 * | remove | 节点 → 存在 → 队长 → **不能踢自己** → 是成员就踢、是请求就静默删 |
 * | close | 节点 → 存在 → 队长 → 广播 `party_close` 给所有人 → 派对消失 |
 * | requests | 节点 → 存在 → 队长 → 回请求列表 |
 *
 * 三条容易抄错的上游行为：
 * 1. `remove` 的"不能踢自己"比的是**三件套**（会话 / 用户 / 用户名），而队长校验
 *    比的是"会话 + 节点"；
 * 2. `remove` 命中一个待批请求时**静默成功**（那条请求的人从来没进过流，不需要
 *    任何退场通知），不撤匹配票（上游在那一支直接 `return nil`）；
 * 3. `close` 之后派对立即消失，此后任何操作都是 `party not found`——"closed"这个
 *    错误值只在"同一个 handler 被关掉一半"的窗口里出现过，本项目里不可达。
 *
 * 契约源（机器可读）：
 * 契约源: server/party_handler.go::PartyHandler.Promote
 * 契约源: server/party_handler.go::PartyHandler.Accept
 * 契约源: server/party_handler.go::PartyHandler.Remove
 * 契约源: server/party_handler.go::PartyHandler.Close
 *
 * REQ-0001-019
 */

import { decideAccept, decidePromote, decideRemove } from "../domain/party/members";
import {
  partyCloseEnvelope,
  partyEnvelope,
  partyJoinRequestEnvelope,
  partyLeaderEnvelope,
  type PartyActor,
  type PartyCloseInput,
  type PartyOpResult,
} from "../realtime/party";
import { ackEnvelope } from "../realtime/errors";
import { fail } from "./party-op";
import { leaderOnly, nodeGuard, type PartyRuntime } from "./party-runtime";
import { samePresence } from "./party-delivery";

/** `party_promote` / `party_accept` / `party_remove` 的服务层实现。 */
export class PartyRosterOps {
  constructor(private readonly runtime: PartyRuntime) {}

  async promote(input: PartyActor): Promise<PartyOpResult> {
    const guard = nodeGuard(this.runtime, input.node) ?? leaderOnly(this.runtime, input.sessionId, input.node);
    if (guard !== null) return guard;

    const decision = decidePromote(this.runtime.members.entries(), input.presence);
    if (!decision.ok) return fail(decision.kind);

    this.runtime.members.setLeader(decision.member.presence);
    const frame = partyLeaderEnvelope(this.runtime.partyId, decision.member.presence);
    // 上游先 `SendToStream`（回执之前），所以调用方收到的是"先提升、后 ack"。
    await this.runtime.delivery.broadcastExcept(input.sessionId, frame);
    return { ok: true, replies: [frame, ackEnvelope(input.cid)] };
  }

  async accept(input: PartyActor): Promise<PartyOpResult> {
    const guard = nodeGuard(this.runtime, input.node) ?? leaderOnly(this.runtime, input.sessionId, input.node);
    if (guard !== null) return guard;
    const meta = this.runtime.members.meta();
    if (meta === null) return fail("not-found");

    const decision = decideAccept(
      this.runtime.members.entries(),
      this.runtime.requests.entries(),
      meta.maxSize,
      input.presence,
    );
    if (!decision.ok) return fail(decision.kind);

    this.runtime.requests.remove(decision.request.presence.sessionId);
    this.runtime.members.upsert(input.presence, input.presence.node, false);
    await this.runtime.delivery.syncRecord(this.runtime.uuid);

    // 上游 `UserJoin` 触发 `Join` 钩子：给新人一条 `party` 帧，再向流上所有人
    // （含新人自己）广播 presence 事件。`party` 帧不带标签、`hidden` 恒为 false
    // ——上游那段代码没设这两个字段，protojson 里就是零值。
    await this.runtime.delivery.broadcastTo(
      [input.presence],
      partyEnvelope("", {
        partyId: this.runtime.partyId,
        open: meta.open,
        hidden: false,
        maxSize: meta.maxSize,
        self: input.presence,
        leader: this.runtime.members.leader() ?? input.presence,
        presences: this.runtime.delivery.presences(),
        label: undefined,
      }),
    );
    await this.runtime.delivery.broadcastPresence([input.presence], []);
    await this.runtime.delivery.membershipChanged();
    return { ok: true, replies: [ackEnvelope(input.cid)] };
  }

  async remove(input: PartyActor): Promise<PartyOpResult> {
    const guard = nodeGuard(this.runtime, input.node) ?? leaderOnly(this.runtime, input.sessionId, input.node);
    if (guard !== null) return guard;

    const leader = this.runtime.members.leader();
    if (leader !== null && samePresence(leader, input.presence)) return fail("remove-self");

    const decision = decideRemove(
      this.runtime.members.entries(),
      this.runtime.requests.entries(),
      input.presence,
    );
    if (!decision.ok) return fail(decision.kind);
    if (decision.outcome === "request") {
      // 待批请求的人从来没进过流：静默删掉，不广播、不撤票。
      this.runtime.requests.remove(input.presence.sessionId);
      return { ok: true, replies: [ackEnvelope(input.cid)] };
    }

    this.runtime.members.remove(input.presence.sessionId);
    await this.runtime.delivery.syncRecord(this.runtime.uuid);
    // 被踢的那位拿到的是一条 `party_close`（上游在 `UserLeave` 之后显式补投）。
    await this.runtime.delivery.afterDeparture([input.presence], [
      { target: input.presence, frame: partyCloseEnvelope(this.runtime.partyId) },
    ]);
    return { ok: true, replies: [ackEnvelope(input.cid)] };
  }

  async close(input: PartyCloseInput): Promise<PartyOpResult> {
    const guard = nodeGuard(this.runtime, input.node) ?? leaderOnly(this.runtime, input.sessionId, input.node);
    if (guard !== null) return guard;

    const frame = partyCloseEnvelope(this.runtime.partyId);
    await this.runtime.delivery.broadcastExcept(input.sessionId, frame);
    await this.runtime.delivery.destroy();
    return { ok: true, replies: [frame, ackEnvelope(input.cid)] };
  }

  joinRequestList(input: PartyCloseInput & { readonly rawPartyId: string }): PartyOpResult {
    const guard = nodeGuard(this.runtime, input.node) ?? leaderOnly(this.runtime, input.sessionId, input.node);
    if (guard !== null) return guard;
    // 上游这里回的是**客户端原样给的 id**（`incoming.PartyId`），不是规整后的
    // `IDStr`——大写 uuid 的请求会原样照回。这一处只有这个端点如此。
    return {
      ok: true,
      replies: [
        partyJoinRequestEnvelope(
          input.rawPartyId,
          this.runtime.requests.entries().map((entry) => entry.presence),
        ),
      ],
    };
  }

}
