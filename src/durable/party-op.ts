/**
 * 派对操作的结果形状：DO 与管线之间唯一的失败协议。
 *
 * 上游把两类东西拼进同一条错误帧：**管线的前缀**（`Error joining party: `）+
 * **服务层的错误串**（`party not found` / `matchmaker query invalid` / ...）。
 * 这条分界线决定了 `PartyOpFailure` 的两个分支：
 *
 * - `{code:"party", reason}`：文案是固定的 `runtime.ErrParty*` 那一串，表在
 *   `src/domain/party/errors.ts`，谁都不许在这里手拼；
 * - `{code:"text", message}`：文案是**算出来的**——标签解析失败要带细节，
 *   匹配器失败要把匹配器自己的错误串原样透传。
 *
 * 分两支的意义：管线只加前缀，一个字都不改；而"哪一条失败对应哪一串"这件事
 * 只有一处实现，测试可以直接对着它断言。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_party.go::Pipeline.partyCreate
 * 契约源: server/pipeline_party.go::Pipeline.partyMatchmakerAdd
 *
 * REQ-0001-019
 */

import type { PartyFailureKind } from "../domain/party/errors";
import type { PartyOpResult } from "../realtime/party";
import type { MatchmakerFailure } from "../domain/matchmaker/errors";

/** 固定文案失败。 */
export function fail(kind: PartyFailureKind): PartyOpResult {
  return { ok: false, failure: { code: "party", reason: kind } };
}

/** 透传文案失败（标签解析细节 / 匹配器错误串）。 */
export function failText(message: string): PartyOpResult {
  return { ok: false, failure: { code: "text", message } };
}

/**
 * 匹配器失败 → 上游 `runtime.ErrMatchmaker*` 的逐字文案。
 *
 * 注意这不是"派对失败"：上游 `PartyHandler.MatchmakerAdd` 直接把匹配器返回的
 * error 往上抛，管线再拼 `Error adding party to matchmaker: %s`，所以这里必须
 * 透传匹配器自己的措辞（`matchmaker query invalid` 而不是 `party ...`）。
 */
export function matchmakerFailureText(failure: MatchmakerFailure): string {
  return MATCHMAKER_FAILURE_TEXT[failure];
}

const MATCHMAKER_FAILURE_TEXT: Readonly<Record<MatchmakerFailure, string>> = {
  "query-invalid": "matchmaker query invalid",
  "duplicate-session": "matchmaker duplicate session",
  "too-many-tickets": "matchmaker too many tickets",
  "ticket-not-found": "matchmaker ticket not found",
  "not-available": "matchmaker not available",
};
