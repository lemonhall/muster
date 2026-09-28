/**
 * 派对的数据面与目录面四个动作：发数据、改标签、加票、撤票。
 *
 * | 动作 | 校验顺序 |
 * |---|---|
 * | data_send | 节点 → 存在 → **发送者必须是成员**（会话 + 节点） |
 * | update | **隐藏派对不许带非空标签** → 节点 → 存在 → 队长 → 标签长度 → 标签 JSON |
 * | matchmaker_add | 节点 → 存在 → 队长 → 匹配器（错误串原样透传） |
 * | matchmaker_remove | 节点 → 存在 → 队长 → 匹配器 |
 *
 * 四条容易抄错的上游行为：
 * 1. `update` 的隐藏校验在 registry 层、**先于**节点校验与队长校验；
 * 2. `data_send` **不回显发送者**（上游把发送者从收件人里排掉），而且发送者判据是
 *    "会话 + 节点"——与 `promote` 的三件套不同；
 * 3. `data_send` 的标签是 `party_update` 的**原文**（空串照样广播空串），而库里存的
 *    是规整后的 `{}`；
 * 4. 匹配器失败是**透传**的：`Error adding party to matchmaker: matchmaker query
 *    invalid` 里的后半句来自匹配器自己，不是派对域的固定文案。
 *
 * 契约源（机器可读）：
 * 契约源: server/party_handler.go::PartyHandler.DataSend
 * 契约源: server/party_handler.go::PartyHandler.Update
 * 契约源: server/party_handler.go::PartyHandler.MatchmakerAdd
 * 契约源: server/party_handler.go::PartyHandler.MatchmakerRemove
 *
 * REQ-0001-019
 */

import { findSender, realMembers } from "../domain/party/members";
import { hiddenNonEmptyLabel, parsePartyLabel, storedLabel } from "../domain/party/label";
import type { MatchmakerFailure } from "../domain/matchmaker/errors";
import {
  partyDataEnvelope,
  partyMatchmakerTicketEnvelope,
  partyUpdateEnvelope,
  type PartyDataInput,
  type PartyMatchmakerAddInput,
  type PartyMatchmakerRemoveInput,
  type PartyOpResult,
  type PartyUpdateInput,
} from "../realtime/party";
import { ackEnvelope } from "../realtime/errors";
import { matchmakerCall } from "./matchmaker-call";
import { fail, failText, matchmakerFailureText } from "./party-op";
import { leaderOnly, nodeGuard, type PartyRuntime } from "./party-runtime";

export class PartyFrameOps {
  constructor(private readonly runtime: PartyRuntime) {}

  async dataSend(input: PartyDataInput): Promise<PartyOpResult> {
    const guard = nodeGuard(this.runtime, input.node);
    if (guard !== null) return guard;
    if (this.runtime.members.meta() === null) return fail("not-found");

    const sender = findSender(this.runtime.members.entries(), input.sessionId, input.node);
    if (sender === undefined) return fail("not-member");

    const recipients = realMembers(this.runtime.members.entries())
      .map((entry) => entry.presence)
      .filter((presence) => presence.sessionId !== input.sessionId);
    await this.runtime.delivery.broadcastTo(
      recipients,
      partyDataEnvelope(this.runtime.partyId, sender.presence, input.opCode, input.data),
    );
    return { ok: true, replies: [ackEnvelope(input.cid)] };
  }

  async update(input: PartyUpdateInput): Promise<PartyOpResult> {
    if (hiddenNonEmptyLabel(input.label, input.hidden)) return fail("hidden-label");
    const guard = nodeGuard(this.runtime, input.node) ?? leaderOnly(this.runtime, input.sessionId, input.node);
    if (guard !== null) return guard;

    const problem = parsePartyLabel(input.label);
    if (problem !== null) {
      return problem.kind === "label-too-long" ? fail("label-too-long") : failText(problem.message);
    }

    this.runtime.members.setListing(input.open, input.hidden, storedLabel(input.label));
    await this.runtime.delivery.syncRecord(this.runtime.uuid);
    const frame = partyUpdateEnvelope(this.runtime.partyId, input.open, input.hidden, input.label);
    await this.runtime.delivery.broadcastExcept(input.sessionId, frame);
    return { ok: true, replies: [frame, ackEnvelope(input.cid)] };
  }

  /** 队长把整个派对当一张票投进匹配池；票面属于派对（`party_id = 派对 id`）。 */
  async matchmakerAdd(
    input: PartyMatchmakerAddInput & { readonly rawPartyId: string },
  ): Promise<PartyOpResult> {
    const guard = nodeGuard(this.runtime, input.node) ?? leaderOnly(this.runtime, input.sessionId, input.node);
    if (guard !== null) return guard;

    const members = realMembers(this.runtime.members.entries()).map((entry) => entry.presence);
    const raw = await matchmakerCall(this.runtime.env, this.runtime.tenantId, "/addParty", {
      partyId: this.runtime.partyId,
      presences: members,
      query: input.query,
      minCount: input.minCount,
      maxCount: input.maxCount,
      countMultiple: input.countMultiple,
      stringProperties: input.stringProperties,
      numericProperties: input.numericProperties,
    });
    if (raw["ok"] !== true) return failText(matchmakerFailureText(readMatchmakerFailure(raw)));
    const ticket = raw["ticket"];
    if (typeof ticket !== "string") throw new Error("匹配器没有返回票号");

    // 票号帧发两次：一次带 cid 回给队长，一次不带 cid 给其余成员（上游就是这样）。
    await this.runtime.delivery.broadcastTo(
      members.filter((presence) => presence.sessionId !== input.sessionId),
      partyMatchmakerTicketEnvelope("", input.rawPartyId, ticket),
    );
    return { ok: true, replies: [partyMatchmakerTicketEnvelope(input.cid, input.rawPartyId, ticket)] };
  }

  async matchmakerRemove(input: PartyMatchmakerRemoveInput): Promise<PartyOpResult> {
    const guard = nodeGuard(this.runtime, input.node) ?? leaderOnly(this.runtime, input.sessionId, input.node);
    if (guard !== null) return guard;

    const raw = await matchmakerCall(this.runtime.env, this.runtime.tenantId, "/removeParty", {
      partyId: this.runtime.partyId,
      ticket: input.ticket,
    });
    if (raw["ok"] !== true) return failText(matchmakerFailureText(readMatchmakerFailure(raw)));
    return { ok: true, replies: [ackEnvelope(input.cid)] };
  }
}

/** 匹配器返回的失败必须是我们认得的那几种，否则宁可直接炸（500）也不糊过去。 */
function readMatchmakerFailure(raw: Record<string, unknown>): MatchmakerFailure {
  const failure = raw["failure"];
  switch (failure) {
    case "query-invalid":
    case "duplicate-session":
    case "too-many-tickets":
    case "ticket-not-found":
    case "not-available":
      return failure;
    default:
      throw new Error(`匹配器返回了无法识别的失败类型：${String(failure)}`);
  }
}
