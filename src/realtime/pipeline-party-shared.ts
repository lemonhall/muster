/**
 * 派对入站帧的公共件：前缀常量、失败封装、presence 形状判定。
 *
 * 这一层只做"管线级"的事——**加前缀、选错误码、决定关不关连接**；
 * 真正的语义（谁能踢谁、队长怎么转移）在 `src/domain/party/*` 与派对的 DO 里。
 *
 * 三条反直觉但必须复刻的上游行为集中在这里的注释里：
 * 1. `party_matchmaker_remove` 失败时**误用** `Error closing party:` 前缀（上游
 *    `pipeline_party.go` 里真的这么写的），不是 "removing"；
 * 2. `party_create` 的大小校验是 `< 0 || > 256`——`max_size = 0` 能过，文案却写着
 *    "must be 1-256"；
 * 3. `promote` / `accept` / `remove` 是**先校验 presence、后校验 id**，而且 presence
 *    的判据是"三个字段都非空"（`username` 为空也叫 Invalid presence）。
 *
 * 所有失败路径都返回 `close: true`：上游这些分支一律 `return false, nil`，
 * `ProcessRequest` 返回 false → `sessionWS.consume` 关连接。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_party.go::Pipeline.partyCreate
 * 契约源: server/pipeline_party.go::Pipeline.partyPromote
 * 契约源: server/pipeline_party.go::Pipeline.partyLeave
 *
 * REQ-0001-019
 */

import { Error_Code } from "../proto/realtime_pb";
import type { UserPresence } from "../proto/realtime_pb";
import { failureText } from "../domain/party/errors";
import { parsePartyId } from "../domain/party/ids";
import type { PartyPresence } from "../domain/party/types";
import { LOCAL_NODE } from "../domain/party/ids";
import { errorEnvelope } from "./errors";
import type { PartyOpResult } from "./party";
import type { PipelineContext, PipelineResult } from "./pipeline";

export const INVALID_PARTY_MAX_SIZE = "Invalid party max size, must be 1-256";
export const INVALID_PARTY_ID = "Invalid party ID";
export const INVALID_PRESENCE = "Invalid presence";
export const INVALID_MATCHMAKER_TICKET = "Invalid matchmaker ticket";
export const INVALID_MIN_COUNT = "Invalid minimum count, must be >= 2";
export const INVALID_MAX_COUNT = "Invalid maximum count, must be >= minimum count";
export const INVALID_COUNT_MULTIPLE = "Invalid count multiple, must be >= 1";
export const INVALID_MULTIPLE_FOR_MIN = "Invalid count multiple for minimum count, must divide";
export const INVALID_MULTIPLE_FOR_MAX = "Invalid count multiple for maximum count, must divide";

export function fail(cid: string, message: string): PipelineResult {
  return { replies: [errorEnvelope(cid, Error_Code.BAD_INPUT, message)], close: true };
}

/** 服务层失败 → 管线结果：加前缀的是这一层，选词的是服务层。 */
export function outcome(cid: string, prefix: string, result: PartyOpResult): PipelineResult {
  if (result.ok) return { replies: result.replies, close: false };
  const failure = result.failure;
  const message = failure.code === "party" ? failureText(failure.reason) : failure.message;
  return fail(cid, `${prefix}: ${message}`);
}

/** 管线里的"我"：上游用 session 的三件套现拼一个 `rtapi.UserPresence`。 */
export function selfOf(context: PipelineContext): PartyPresence {
  return {
    userId: context.userId,
    sessionId: context.sessionId,
    username: context.username,
    node: LOCAL_NODE,
  };
}

export function presenceInvalid(presence: UserPresence | undefined): boolean {
  return (
    presence === undefined ||
    presence.userId === "" ||
    presence.sessionId === "" ||
    presence.username === ""
  );
}

export function presenceOf(presence: UserPresence): PartyPresence {
  return {
    userId: presence.userId,
    sessionId: presence.sessionId,
    username: presence.username,
    node: LOCAL_NODE,
  };
}

/** 解析派对 id；坏形状返回 `null`。**大小写原样保留**（上游回执原样照回）。 */
export function partsOrNull(
  partyId: string,
): { readonly uuid: string; readonly node: string } | null {
  return parsePartyId(partyId);
}
