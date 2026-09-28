/**
 * 把整支派对当**一张票**投进匹配池的两条帧。
 *
 * 校验顺序逐条对齐上游 `server/pipeline_party.go`（注意 `min_count` 的判据是
 * `< 2`，因为一张派对票至少代表两个人）：
 *
 * 1. `min_count < 2` → `Invalid minimum count, must be >= 2`
 * 2. `max_count < min_count` → `Invalid maximum count, must be >= minimum count`
 * 3. `count_multiple` 给了才校验：`< 1` → 报 `must be >= 1`；然后两个整除判据
 * 4. **空查询串规整成 `*`**（匹配器自己不做这件事，它只认已规整的串）
 * 5. `party_id` 形状
 *
 * `remove` 那条有一个必须照抄的**上游笔误**：失败前缀是 `Error closing party:`
 * （不是 "removing"）。空 ticket 的判据在 id 形状之前。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_party.go::Pipeline.partyMatchmakerAdd
 * 契约源: server/pipeline_party.go::Pipeline.partyMatchmakerRemove
 *
 * REQ-0001-019
 */

import type { PartyMatchmakerAdd, PartyMatchmakerRemove } from "../proto/realtime_pb";
import {
  INVALID_COUNT_MULTIPLE,
  INVALID_MATCHMAKER_TICKET,
  INVALID_MAX_COUNT,
  INVALID_MIN_COUNT,
  INVALID_MULTIPLE_FOR_MAX,
  INVALID_MULTIPLE_FOR_MIN,
  INVALID_PARTY_ID,
  fail,
  outcome,
  partsOrNull,
} from "./pipeline-party-shared";
import type { PipelineContext, PipelineResult } from "./pipeline";

export async function partyMatchmakerAdd(
  context: PipelineContext,
  cid: string,
  incoming: PartyMatchmakerAdd,
): Promise<PipelineResult> {
  const minCount = incoming.minCount;
  if (minCount < 2) return fail(cid, INVALID_MIN_COUNT);
  const maxCount = incoming.maxCount;
  if (maxCount < minCount) return fail(cid, INVALID_MAX_COUNT);
  let countMultiple = 1;
  if (incoming.countMultiple !== undefined) {
    countMultiple = incoming.countMultiple;
    if (countMultiple < 1) return fail(cid, INVALID_COUNT_MULTIPLE);
    if (minCount % countMultiple !== 0) return fail(cid, INVALID_MULTIPLE_FOR_MIN);
    if (maxCount % countMultiple !== 0) return fail(cid, INVALID_MULTIPLE_FOR_MAX);
  }
  // 上游在这里把空查询串规整成 `*`（匹配器自己不做这件事）。
  const query = incoming.query === "" ? "*" : incoming.query;
  const parts = partsOrNull(incoming.partyId);
  if (parts === null) return fail(cid, INVALID_PARTY_ID);
  return outcome(
    cid,
    "Error adding party to matchmaker",
    await context.party.matchmakerAdd({
      cid,
      partyId: incoming.partyId,
      node: parts.node,
      sessionId: context.sessionId,
      rawPartyId: incoming.partyId,
      query,
      minCount,
      maxCount,
      countMultiple,
      stringProperties: incoming.stringProperties,
      numericProperties: incoming.numericProperties,
    }),
  );
}

export async function partyMatchmakerRemove(
  context: PipelineContext,
  cid: string,
  incoming: PartyMatchmakerRemove,
): Promise<PipelineResult> {
  if (incoming.ticket === "") return fail(cid, INVALID_MATCHMAKER_TICKET);
  const parts = partsOrNull(incoming.partyId);
  if (parts === null) return fail(cid, INVALID_PARTY_ID);
  // 上游此处**误用** `Error closing party:`（原文如此），照抄。
  return outcome(
    cid,
    "Error closing party",
    await context.party.matchmakerRemove({
      cid,
      partyId: incoming.partyId,
      node: parts.node,
      sessionId: context.sessionId,
      ticket: incoming.ticket,
    }),
  );
}
