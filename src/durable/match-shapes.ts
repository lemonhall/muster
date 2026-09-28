/**
 * 对局语义层的形状与结果构造器：入参类型、元数据、以及三种失败形态。
 *
 * 与 `match-core.ts` 分开只为一件事：**一个文件的职责要能被一眼说完**。
 * 形状会跟着上游 `rtapi` 变，语义不会；放在一起改的时候容易互相带偏。
 *
 * 失败形态来自上游 `server/pipeline_match.go`：
 *   - `not-found` → `MATCH_NOT_FOUND` + `Match not found`；
 *   - `rejected` → `MATCH_JOIN_REJECTED` + 服务端理由；
 *   - `silent` → 上游 `return false, nil`：**不发任何帧**，直接关连接。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_match.go::Pipeline.matchJoin
 * 契约源: server/pipeline_match.go::Pipeline.matchDataSend
 *
 * REQ-0001-018
 */

import type { MatchDataFilter } from "../domain/match/data";
import type { MatchOpResult } from "../realtime/match";

export interface MatchMeta {
  readonly authoritative: boolean;
  /** NULL（D1/存储里）表示"没有 label 字段"；这里用 `undefined` 表达同一件事。 */
  readonly label: string | undefined;
  readonly node: string;
  readonly createTime: number;
}

export interface JoinInput {
  readonly cid: string;
  /** 客户端送来的原始 match id（回执要原样回带它，上游就是这么做的）。 */
  readonly matchId: string;
  readonly node: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly username: string;
  readonly allowEmpty: boolean;
}

export interface LeaveInput {
  readonly cid: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly username: string;
  readonly node: string;
}

export interface DataInput {
  readonly matchId: string;
  readonly node: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly username: string;
  readonly opCode: bigint;
  readonly data: Uint8Array;
  readonly reliable: boolean;
  readonly filters: readonly MatchDataFilter[];
}

export function notFound(): MatchOpResult {
  return { ok: false, failure: { kind: "not-found" } };
}

/** 上游 `return false, nil`：不发帧、关连接。 */
export function silent(): MatchOpResult {
  return { ok: false, failure: { kind: "silent" } };
}
