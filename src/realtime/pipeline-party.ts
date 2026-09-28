/**
 * 派对的十一条入站帧：`party_*` 全家桶。
 *
 * 逐行对齐上游 `server/pipeline_party.go`。**校验顺序就是契约**——同一个坏请求
 * 落在两条校验之间时报哪一条，客户端看得见：
 *
 * | 帧 | 顺序 | 失败文案（前缀 + 服务层） |
 * |---|---|---|
 * | create | max_size 范围（`<0 || >256`，注意 **0 是合法的**） | `Invalid party max size, must be 1-256`、`Error creating party: <err>` |
 * | join | id 形状 | `Invalid party ID`、`Error joining party: <err>` |
 * | leave | id 形状 | `Invalid party ID`（上游这条路径**从不失败**） |
 * | promote / accept / remove | **先 presence 三件套，后 id 形状** | `Invalid presence`、`Invalid party ID`、`Error promoting new party leader: <err>` / `Error accepting party join request: <err>` / `Error removing party member or join request: <err>` |
 * | close | id 形状 | `Invalid party ID`、`Error closing party: <err>` |
 * | join_request_list | id 形状 | `Invalid party ID`、`Error listing party join requests: <err>` |
 * | matchmaker_add | min≥2 → max≥min → multiple≥1 → 两个整除 → query 空转 `*` → id 形状 | `Invalid minimum count, must be >= 2` 等五条、`Invalid party ID`、`Error adding party to matchmaker: <err>` |
 * | matchmaker_remove | **空的 ticket**，再 id 形状 | `Invalid matchmaker ticket`、`Invalid party ID`、`Error closing party: <err>` |
 * | data_send | id 形状 | `Invalid party ID`、`Error sending party data: <err>` |
 * | update | id 形状 | `Invalid party ID`、`Error updating party: <err>` |
 *
 * 本文件承载**生命周期与数据面**六条（create / join / leave / close / update / data_send）；
 * 人员编排（promote / accept / remove / join_request_list）在 `pipeline-party-roster.ts`，
 * 匹配池两条在 `pipeline-party-matchmaker.ts`；公共件在 `pipeline-party-shared.ts`。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_party.go::Pipeline.partyJoin
 * 契约源: server/pipeline_party.go::Pipeline.partyClose
 * 契约源: server/pipeline_party.go::Pipeline.partyDataSend
 * 契约源: server/pipeline_party.go::Pipeline.partyUpdate
 *
 * REQ-0001-019
 */

import type {
  PartyClose,
  PartyCreate,
  PartyDataSend,
  PartyJoin,
  PartyLeave,
  PartyUpdate,
} from "../proto/realtime_pb";
import {
  INVALID_PARTY_ID,
  INVALID_PARTY_MAX_SIZE,
  fail,
  outcome,
  partsOrNull,
  selfOf,
} from "./pipeline-party-shared";
import type { PipelineContext, PipelineResult } from "./pipeline";

export {
  partyAccept,
  partyJoinRequestList,
  partyPromote,
  partyRemove,
} from "./pipeline-party-roster";
export { partyMatchmakerAdd, partyMatchmakerRemove } from "./pipeline-party-matchmaker";

export async function partyCreate(
  context: PipelineContext,
  cid: string,
  incoming: PartyCreate,
): Promise<PipelineResult> {
  // 注意判据是 `< 0 || > 256`：`max_size = 0` 是能过的（文案却写着 1-256）。
  if (incoming.maxSize < 0 || incoming.maxSize > 256) return fail(cid, INVALID_PARTY_MAX_SIZE);
  return outcome(
    cid,
    "Error creating party",
    await context.party.create({
      cid,
      self: selfOf(context),
      open: incoming.open,
      hidden: incoming.hidden,
      maxSize: incoming.maxSize,
      label: incoming.label,
    }),
  );
}

export async function partyJoin(
  context: PipelineContext,
  cid: string,
  incoming: PartyJoin,
): Promise<PipelineResult> {
  const parts = partsOrNull(incoming.partyId);
  if (parts === null) return fail(cid, INVALID_PARTY_ID);
  return outcome(
    cid,
    "Error joining party",
    await context.party.join({
      cid,
      partyId: incoming.partyId,
      node: parts.node,
      self: selfOf(context),
    }),
  );
}

export async function partyLeave(
  context: PipelineContext,
  cid: string,
  incoming: PartyLeave,
): Promise<PipelineResult> {
  const parts = partsOrNull(incoming.partyId);
  if (parts === null) return fail(cid, INVALID_PARTY_ID);
  // 上游这一条走的是 `tracker.Untrack`，没有任何失败分支；前缀只是防御性兜底。
  return outcome(
    cid,
    "Error leaving party",
    await context.party.leave({
      cid,
      partyId: incoming.partyId,
      node: parts.node,
      sessionId: context.sessionId,
    }),
  );
}

export async function partyClose(
  context: PipelineContext,
  cid: string,
  incoming: PartyClose,
): Promise<PipelineResult> {
  const parts = partsOrNull(incoming.partyId);
  if (parts === null) return fail(cid, INVALID_PARTY_ID);
  return outcome(
    cid,
    "Error closing party",
    await context.party.close({
      cid,
      partyId: incoming.partyId,
      node: parts.node,
      sessionId: context.sessionId,
    }),
  );
}

export async function partyDataSend(
  context: PipelineContext,
  cid: string,
  incoming: PartyDataSend,
): Promise<PipelineResult> {
  const parts = partsOrNull(incoming.partyId);
  if (parts === null) return fail(cid, INVALID_PARTY_ID);
  return outcome(
    cid,
    "Error sending party data",
    await context.party.dataSend({
      cid,
      partyId: incoming.partyId,
      node: parts.node,
      sessionId: context.sessionId,
      opCode: incoming.opCode,
      data: incoming.data,
    }),
  );
}

export async function partyUpdate(
  context: PipelineContext,
  cid: string,
  incoming: PartyUpdate,
): Promise<PipelineResult> {
  const parts = partsOrNull(incoming.partyId);
  if (parts === null) return fail(cid, INVALID_PARTY_ID);
  return outcome(
    cid,
    "Error updating party",
    await context.party.update({
      cid,
      partyId: incoming.partyId,
      node: parts.node,
      sessionId: context.sessionId,
      label: incoming.label,
      open: incoming.open,
      hidden: incoming.hidden,
    }),
  );
}
