/**
 * 派对人员编排的四条帧：`promote` / `accept` / `remove` / `join_request_list`。
 *
 * 这四条里前三条有一个**共同的反直觉顺序**：先校验 presence 三件套，后校验 party id。
 * 上游 `pipeline_party.go` 就是这么排的，所以"presence 坏 + id 也坏"的请求报的是
 * `Invalid presence`；presence 的判据是"三个字段都非空"，`username` 为空同样算坏。
 *
 * `join_request_list` 是唯一一条回执里带**客户端原文 id** 的（不做归一）。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_party.go::Pipeline.partyPromote
 * 契约源: server/pipeline_party.go::Pipeline.partyAccept
 * 契约源: server/pipeline_party.go::Pipeline.partyRemove
 * 契约源: server/pipeline_party.go::Pipeline.partyJoinRequestList
 *
 * REQ-0001-019
 */

import type {
  PartyAccept,
  PartyJoinRequestList,
  PartyPromote,
  PartyRemove,
  UserPresence,
} from "../proto/realtime_pb";
import {
  INVALID_PARTY_ID,
  INVALID_PRESENCE,
  fail,
  outcome,
  partsOrNull,
  presenceInvalid,
  presenceOf,
} from "./pipeline-party-shared";
import type { PipelineContext, PipelineResult } from "./pipeline";

export async function partyPromote(
  context: PipelineContext,
  cid: string,
  incoming: PartyPromote,
): Promise<PipelineResult> {
  if (presenceInvalid(incoming.presence)) return fail(cid, INVALID_PRESENCE);
  const parts = partsOrNull(incoming.partyId);
  if (parts === null) return fail(cid, INVALID_PARTY_ID);
  return outcome(
    cid,
    "Error promoting new party leader",
    await context.party.promote({
      cid,
      partyId: incoming.partyId,
      node: parts.node,
      sessionId: context.sessionId,
      presence: presenceOf(incoming.presence as UserPresence),
    }),
  );
}

export async function partyAccept(
  context: PipelineContext,
  cid: string,
  incoming: PartyAccept,
): Promise<PipelineResult> {
  if (presenceInvalid(incoming.presence)) return fail(cid, INVALID_PRESENCE);
  const parts = partsOrNull(incoming.partyId);
  if (parts === null) return fail(cid, INVALID_PARTY_ID);
  return outcome(
    cid,
    "Error accepting party join request",
    await context.party.accept({
      cid,
      partyId: incoming.partyId,
      node: parts.node,
      sessionId: context.sessionId,
      presence: presenceOf(incoming.presence as UserPresence),
    }),
  );
}

export async function partyRemove(
  context: PipelineContext,
  cid: string,
  incoming: PartyRemove,
): Promise<PipelineResult> {
  if (presenceInvalid(incoming.presence)) return fail(cid, INVALID_PRESENCE);
  const parts = partsOrNull(incoming.partyId);
  if (parts === null) return fail(cid, INVALID_PARTY_ID);
  return outcome(
    cid,
    "Error removing party member or join request",
    await context.party.remove({
      cid,
      partyId: incoming.partyId,
      node: parts.node,
      sessionId: context.sessionId,
      presence: presenceOf(incoming.presence as UserPresence),
    }),
  );
}

export async function partyJoinRequestList(
  context: PipelineContext,
  cid: string,
  incoming: PartyJoinRequestList,
): Promise<PipelineResult> {
  const parts = partsOrNull(incoming.partyId);
  if (parts === null) return fail(cid, INVALID_PARTY_ID);
  return outcome(
    cid,
    "Error listing party join requests",
    await context.party.joinRequestList({
      cid,
      partyId: incoming.partyId,
      node: parts.node,
      sessionId: context.sessionId,
      rawPartyId: incoming.partyId,
    }),
  );
}
