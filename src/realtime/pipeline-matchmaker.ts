/**
 * 匹配器的两条入站帧：`matchmaker_add` / `matchmaker_remove`。
 *
 * 逐行照抄上游 `server/pipeline_matchmaker.go`。**校验顺序本身是契约**——一张
 * `min_count=1` 且 `count_multiple=0` 的票，客户端被告知的是"最小人数错了"，
 * 因为上游就是先看这一条。五条文案一个字都不能改：
 *
 * | 条件 | 文案 |
 * |---|---|
 * | `min_count < 2` | `Invalid minimum count, must be >= 2` |
 * | `max_count < min_count` | `Invalid maximum count, must be >= minimum count` |
 * | `count_multiple < 1` | `Invalid count multiple, must be >= 1` |
 * | `min_count % count_multiple != 0` | `Invalid count multiple for minimum count, must divide` |
 * | `max_count % count_multiple != 0` | `Invalid count multiple for maximum count, must divide` |
 *
 * 两条容易被忽略的细节：
 * 1. 空查询串会被改写成 `*`（"什么都匹配"），不是报错；
 * 2. 上游把"宿主错误"（池子里的任何失败）统一翻成 `Error adding to matchmaker`，
 *    而撤票的两种失败是**分开**的：票不存在是 `BAD_INPUT`，其余是
 *    `RUNTIME_EXCEPTION`。这四条文案各自都有对应的上游分支。
 *
 * 所有失败路径都会**关闭会话**（上游 `return false, nil`）。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_matchmaker.go::Pipeline.matchmakerAdd
 * 契约源: server/pipeline_matchmaker.go::Pipeline.matchmakerRemove
 *
 * REQ-0001-017
 */

import { Error_Code, type MatchmakerAdd, type MatchmakerRemove } from "../proto/realtime_pb";
import { ackEnvelope, errorEnvelope } from "./errors";
import { matchmakerTicketEnvelope } from "./matchmaker";
import type { PipelineContext, PipelineResult } from "./pipeline";

const INVALID_MIN = "Invalid minimum count, must be >= 2";
const INVALID_MAX = "Invalid maximum count, must be >= minimum count";
const INVALID_MULTIPLE = "Invalid count multiple, must be >= 1";
const INVALID_MULTIPLE_MIN = "Invalid count multiple for minimum count, must divide";
const INVALID_MULTIPLE_MAX = "Invalid count multiple for maximum count, must divide";
const ADD_FAILED = "Error adding to matchmaker";
const REMOVE_FAILED = "Error removing matchmaker ticket";
const INVALID_TICKET = "Invalid matchmaker ticket";
const TICKET_NOT_FOUND = "Matchmaker ticket not found";

/** 失败：回一条错误帧，然后关连接（上游每条 `return false, nil` 都是这个形状）。 */
function fail(cid: string, code: Error_Code, message: string): PipelineResult {
  return { replies: [errorEnvelope(cid, code, message)], close: true };
}

export async function matchmakerAdd(
  context: PipelineContext,
  cid: string,
  incoming: MatchmakerAdd,
): Promise<PipelineResult> {
  if (incoming.minCount < 2) return fail(cid, Error_Code.BAD_INPUT, INVALID_MIN);
  if (incoming.maxCount < incoming.minCount) {
    return fail(cid, Error_Code.BAD_INPUT, INVALID_MAX);
  }

  // `count_multiple` 缺失时默认 1；给了就要过三条检查（顺序固定）。
  let countMultiple = 1;
  if (incoming.countMultiple !== undefined) {
    countMultiple = incoming.countMultiple;
    if (countMultiple < 1) return fail(cid, Error_Code.BAD_INPUT, INVALID_MULTIPLE);
    if (incoming.minCount % countMultiple !== 0) {
      return fail(cid, Error_Code.BAD_INPUT, INVALID_MULTIPLE_MIN);
    }
    if (incoming.maxCount % countMultiple !== 0) {
      return fail(cid, Error_Code.BAD_INPUT, INVALID_MULTIPLE_MAX);
    }
  }

  // 上游：空查询串 = 匹配一切，不是报错。
  const query = incoming.query === "" ? "*" : incoming.query;

  const result = await context.matchmaker.add({
    sessionId: context.sessionId,
    userId: context.userId,
    username: context.username,
    query,
    minCount: incoming.minCount,
    maxCount: incoming.maxCount,
    countMultiple,
    stringProperties: incoming.stringProperties,
    numericProperties: incoming.numericProperties,
  });
  if (!result.ok) return fail(cid, Error_Code.RUNTIME_EXCEPTION, ADD_FAILED);

  return { replies: [matchmakerTicketEnvelope(cid, result.ticket)], close: false };
}

export async function matchmakerRemove(
  context: PipelineContext,
  cid: string,
  incoming: MatchmakerRemove,
): Promise<PipelineResult> {
  if (incoming.ticket === "") return fail(cid, Error_Code.BAD_INPUT, INVALID_TICKET);

  const result = await context.matchmaker.remove({
    sessionId: context.sessionId,
    ticket: incoming.ticket,
  });
  if (!result.ok) {
    // 票不存在是客户端的问题（BAD_INPUT），池子本身出错才是 RUNTIME_EXCEPTION。
    return result.failure === "ticket-not-found"
      ? fail(cid, Error_Code.BAD_INPUT, TICKET_NOT_FOUND)
      : fail(cid, Error_Code.RUNTIME_EXCEPTION, REMOVE_FAILED);
  }

  // 成功只是"收到了"：上游回的是一个只带 cid 的空信封。
  return { replies: [ackEnvelope(cid)], close: false };
}
