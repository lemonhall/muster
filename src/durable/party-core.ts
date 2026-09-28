/**
 * 一个派对实例的生命周期语义：建、进（含加入请求）、出、断连清理。
 *
 * 与 `match-core.ts` / `channel-core.ts` 同一个套路：DO 外壳只解析路由与编解码，
 * 语义在这里，于是"谁能做什么、这一帧该发给谁"可以在不连网络的情况下被读出来。
 * 规则本身在 `src/domain/party/members.ts`（纯函数），这里只负责**顺序**与落盘；
 * 人员编排（批/踢/提拔/关）在 `party-roster-ops.ts`，数据面在 `party-frame-ops.ts`。
 *
 * 四条最容易抄错的上游行为：
 *
 * 1. **`party_leave` 从不失败**：上游先校验 id 形状，然后直接 `tracker.Untrack`——
 *    派对不存在也只是"没什么可摘的"，回到客户端的是只有 cid 的空信封；
 * 2. **成员变动一律撤掉这个派对的匹配票**（`matchmaker.RemovePartyAll`），但
 *    "没人被真的移除"的那次 `Leave` 不算变动，于是也不会撤票；
 * 3. **队长离开 → 最老的那位继任**并广播 `party_leader`；一个不剩 → 派对直接消失，
 *    不发 `party_close`（上游 `stop()`），而**队长主动 `party_close` 会给所有人发**；
 * 4. `party_join` 开放时**直接进**，回执里有一条 `party` 帧；入队的人还会收到
 *    一条 `party_presence_event`（上游 tracker 的流事件，收件人含自己）。
 *
 * 契约源（机器可读）：
 * 契约源: server/party_handler.go::PartyHandler.Join
 * 契约源: server/party_handler.go::PartyHandler.JoinRequest
 * 契约源: server/party_handler.go::PartyHandler.Leave
 *
 * REQ-0001-019
 */

import type { Bindings } from "../env";
import { parsePartyLabel, storedLabel } from "../domain/party/label";
import { decideJoin, decideJoinRequest, decideLeave, oldestOf } from "../domain/party/members";
import type { PartyPresence } from "../domain/party/types";
import { ackEnvelope } from "../realtime/errors";
import {
  partyEnvelope,
  partyJoinRequestEnvelope,
  partyPresenceEventEnvelope,
  type PartyActor,
  type PartyCloseInput,
  type PartyCreateInput,
  type PartyDataInput,
  type PartyJoinInput,
  type PartyJoinRequestListInput,
  type PartyMatchmakerAddRequest,
  type PartyMatchmakerRemoveInput,
  type PartyOpResult,
  type PartyService,
  type PartyUpdateInput,
} from "../realtime/party";
import { PartyFrameOps } from "./party-frame-ops";
import type { PartyMembers } from "./party-members";
import { fail, failText } from "./party-op";
import type { PartyRequests } from "./party-requests";
import { PartyRosterOps } from "./party-roster-ops";
import { createPartyRuntime, nodeGuard, type PartyRuntime } from "./party-runtime";

/** `party_join_request` 给队长的那一条：无 cid，只有一个请求者的 presence。 */
function requestNotice(partyId: string, presence: PartyPresence) {
  return partyJoinRequestEnvelope(partyId, [presence]);
}

export class PartyCore implements PartyService {
  readonly runtime: PartyRuntime;
  readonly #roster: PartyRosterOps;
  readonly #frames: PartyFrameOps;

  constructor(
    env: Bindings,
    tenantId: string,
    uuid: string,
    members: PartyMembers,
    requests: PartyRequests,
    now: () => number = () => Date.now(),
  ) {
    this.runtime = createPartyRuntime(env, tenantId, uuid, members, requests, now);
    this.#roster = new PartyRosterOps(this.runtime);
    this.#frames = new PartyFrameOps(this.runtime);
  }

  /** 对外的派对 id：`<uuid>.<node>`（上游 `PartyHandler.IDStr`）。 */
  get partyId(): string {
    return this.runtime.partyId;
  }

  meta() {
    return this.runtime.members.meta();
  }

  /** 上游 `LocalPartyRegistry.Create` + `pipeline_party.go::partyCreate`。 */
  async create(input: PartyCreateInput): Promise<PartyOpResult> {
    const problem = parsePartyLabel(input.label);
    if (problem !== null) {
      return problem.kind === "label-too-long" ? fail("label-too-long") : failText(problem.message);
    }
    this.runtime.members.setMeta({
      open: input.open,
      hidden: input.hidden,
      maxSize: input.maxSize,
      label: storedLabel(input.label),
      createTime: Math.floor(this.runtime.now() / 1000),
    });
    this.runtime.members.upsert(input.self, input.self.node, false);
    this.runtime.members.setLeader(input.self);
    await this.runtime.delivery.syncRecord(this.runtime.uuid);

    // 上游：回执里的标签是**客户端给的原文**（`Label: incoming.Label`），库里存的是
    // 规整后的 `{}`；之后 tracker 把创建者放进流里，于是流事件"创建者加入"的
    // 收件人也包含创建者自己（`channel-core.ts` 对同一个现象有同样的处理）。
    return {
      ok: true,
      replies: [
        partyEnvelope(input.cid, {
          partyId: this.runtime.partyId,
          open: input.open,
          hidden: input.hidden,
          maxSize: input.maxSize,
          self: input.self,
          leader: input.self,
          presences: [input.self],
          label: input.label,
        }),
        partyPresenceEventEnvelope(this.runtime.partyId, [input.self], []),
      ],
    };
  }

  /**
   * 上游 `pipeline_party.go::partyJoin`：先走 `PartyJoinRequest`（开放则直接进、
   * 私有则排队并通知队长），再按结果决定要不要真的把人放进成员表。
   *
   * 失败文案由管线加上前缀（`Error joining party: `）。
   */
  async join(input: PartyJoinInput): Promise<PartyOpResult> {
    const guard = nodeGuard(this.runtime, input.node);
    if (guard !== null) return guard;
    const meta = this.runtime.members.meta();
    if (meta === null) return fail("not-found");

    const decision = decideJoinRequest(
      this.runtime.members.entries(),
      this.runtime.requests.entries(),
      { maxSize: meta.maxSize, open: meta.open },
      input.self,
    );
    if (!decision.ok) return fail(decision.kind);
    if (!decision.autoJoin) {
      this.runtime.requests.add(input.self, input.self.node);
      const leader = this.runtime.members.leader();
      if (leader !== null) {
        await this.runtime.delivery.broadcastTo(
          [leader],
          requestNotice(this.runtime.partyId, input.self),
        );
      }
      return { ok: true, replies: [ackEnvelope(input.cid)] };
    }

    const joined = decideJoin(this.runtime.members.entries(), meta.maxSize, [input.self]);
    if (!joined.ok) return fail(joined.kind);
    for (const presence of joined.added) {
      this.runtime.members.upsert(presence, presence.node, false);
    }
    if (this.runtime.members.leader() === null) {
      const oldest = oldestOf(this.runtime.members.entries());
      if (oldest !== undefined) this.runtime.members.setLeader(oldest.presence);
    }
    await this.runtime.delivery.syncRecord(this.runtime.uuid);

    const leader = this.runtime.members.leader() ?? input.self;
    const frame = partyEnvelope("", {
      partyId: this.runtime.partyId,
      open: meta.open,
      // 上游 `Join` 钩子那段代码没设 `hidden` 与 `label`，protojson 里就是零值：
      // 无论派对是不是隐藏的，这一帧都报 `hidden` 缺省（即 false）。
      hidden: false,
      maxSize: meta.maxSize,
      self: input.self,
      leader,
      presences: this.runtime.delivery.presences(),
      label: undefined,
    });
    const event = partyPresenceEventEnvelope(this.runtime.partyId, [input.self], []);
    // 自己那一份走 replies（顺序确定：先 party 帧、后 presence 事件），其余成员走投递。
    await this.runtime.delivery.broadcastExcept(input.self.sessionId, event);
    await this.runtime.delivery.membershipChanged();
    // 最后那条空信封带 cid：上游 `partyJoin` 结尾无论走哪一支都会
    // `session.Send(&rtapi.Envelope{Cid: envelope.Cid})`，客户端靠它确认"我进去了"。
    return { ok: true, replies: [frame, event, ackEnvelope(input.cid)] };
  }

  /** 上游 `pipeline_party.go::partyLeave` + `PartyHandler.Leave`。永远成功。 */
  async leave(input: PartyCloseInput): Promise<PartyOpResult> {
    if (this.runtime.members.meta() === null) return { ok: true, replies: [ackEnvelope(input.cid)] };
    const removed = decideLeave(this.runtime.members.entries(), [input.sessionId]);
    if (removed.length === 0) return { ok: true, replies: [ackEnvelope(input.cid)] };
    this.runtime.members.remove(input.sessionId);
    await this.runtime.delivery.syncRecord(this.runtime.uuid);
    await this.runtime.delivery.afterDeparture(removed);
    return { ok: true, replies: [ackEnvelope(input.cid)] };
  }

  /** 连接关闭时的清理：这条会话从本派对消失（幂等）。 */
  async leaveAll(sessionId: string): Promise<void> {
    if (this.runtime.members.meta() === null) return;
    const removed = decideLeave(this.runtime.members.entries(), [sessionId]);
    this.runtime.requests.remove(sessionId);
    if (removed.length === 0) return;
    this.runtime.members.remove(sessionId);
    await this.runtime.delivery.syncRecord(this.runtime.uuid);
    await this.runtime.delivery.afterDeparture(removed);
  }

  promote(input: PartyActor): Promise<PartyOpResult> {
    return this.#roster.promote(input);
  }

  accept(input: PartyActor): Promise<PartyOpResult> {
    return this.#roster.accept(input);
  }

  remove(input: PartyActor): Promise<PartyOpResult> {
    return this.#roster.remove(input);
  }

  close(input: PartyCloseInput): Promise<PartyOpResult> {
    return this.#roster.close(input);
  }

  joinRequestList(input: PartyJoinRequestListInput): Promise<PartyOpResult> {
    return Promise.resolve(this.#roster.joinRequestList(input));
  }

  dataSend(input: PartyDataInput): Promise<PartyOpResult> {
    return this.#frames.dataSend(input);
  }

  update(input: PartyUpdateInput): Promise<PartyOpResult> {
    return this.#frames.update(input);
  }

  matchmakerAdd(input: PartyMatchmakerAddRequest): Promise<PartyOpResult> {
    return this.#frames.matchmakerAdd(input);
  }

  matchmakerRemove(input: PartyMatchmakerRemoveInput): Promise<PartyOpResult> {
    return this.#frames.matchmakerRemove(input);
  }
}
