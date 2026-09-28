/**
 * 会话分片这一侧的**对局**状态：这条会话加入了哪些对局，以及 `MatchService` 的实现。
 *
 * 与 `session-channels.ts` 完全对称，理由也一样：上游连接结束时调用的是
 * `tracker.UntrackAll(sessionID, Update)`，它靠 tracker 里"按会话索引 presence"的那张表
 * 一次性摘掉这条会话在**所有流**（状态、频道、对局）里的 presence。本项目把成员真相
 * 分散到了各个 DO，所以"按会话索引"的这一半只能留在分片：分片记"我加入了谁"，
 * 断开时逐条通知（重复通知是幂等的）。
 *
 * 令牌校验放在这里而不是管线里：它需要租户派生密钥，只有拿着 `env` 的这一层有。
 * "验不过报什么文案"仍然由管线决定——这正是这条分界线的意义。
 *
 * 契约源（机器可读）：
 * 契约源: server/session_ws.go::sessionWS.consume
 * 契约源: server/tracker.go::LocalTracker.UntrackAll
 *
 * REQ-0001-018
 */

import type { Bindings } from "../env";
import { toBase64 } from "../domain/bytes";
import { parseMatchId, type MatchIdParts } from "../domain/match/ids";
import { verifyMatchToken } from "../domain/match/token";
import type {
  MatchCreateInput,
  MatchDataSendInput,
  MatchJoinInput,
  MatchLeaveInput,
  MatchOpResult,
  MatchService,
} from "../realtime/match";
import { matchLeaveAll, matchOp } from "./match-call";

export class SessionMatch implements MatchService {
  constructor(
    private readonly env: Bindings,
    private readonly tenantId: string,
    private readonly sql: SqlStorage,
  ) {}

  /** 由分片在构造时通过 `blockConcurrencyWhile` 调用，保证第一个请求之前表已就绪。 */
  migrate(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS joined_matches (
         match_id TEXT PRIMARY KEY,
         uuid     TEXT NOT NULL
       );`,
    );
  }

  async resolveToken(token: string): Promise<string | null> {
    const nowSec = Math.floor(Date.now() / 1000);
    const claims = await verifyMatchToken(this.env, this.tenantId, token, nowSec);
    return claims === null ? null : claims.mid;
  }

  async create(input: MatchCreateInput): Promise<MatchOpResult> {
    const parts = parseMatchId(input.matchId);
    if (parts === null) return invalid("Invalid match ID");
    const result = await matchOp(this.env, this.tenantId, parts.uuid, "/createRelayed", {
      cid: input.cid,
      matchId: input.matchId,
      sessionId: input.sessionId,
      userId: input.userId,
      username: input.username,
      named: input.named,
    });
    if (result.ok) this.#record(parts);
    return result;
  }

  async join(input: MatchJoinInput): Promise<MatchOpResult> {
    const parts = parseMatchId(input.matchId);
    if (parts === null) return invalid("Invalid match ID");
    const result = await matchOp(this.env, this.tenantId, parts.uuid, "/join", {
      cid: input.cid,
      matchId: input.matchId,
      node: parts.node,
      sessionId: input.sessionId,
      userId: input.userId,
      username: input.username,
      allowEmpty: input.allowEmpty,
    });
    if (result.ok) this.#record(parts);
    return result;
  }

  async leave(input: MatchLeaveInput): Promise<MatchOpResult> {
    const parts = parseMatchId(input.matchId);
    if (parts === null) return invalid("Invalid match ID");
    const result = await matchOp(this.env, this.tenantId, parts.uuid, "/leave", {
      cid: input.cid,
      sessionId: input.sessionId,
      userId: input.userId,
      username: input.username,
      node: parts.node,
    });
    if (result.ok) this.#forget(parts);
    return result;
  }

  async dataSend(input: MatchDataSendInput): Promise<MatchOpResult> {
    const parts = parseMatchId(input.matchId);
    if (parts === null) return invalid("Invalid match ID");
    return await matchOp(this.env, this.tenantId, parts.uuid, "/data", {
      matchId: input.matchId,
      node: parts.node,
      sessionId: input.sessionId,
      userId: input.userId,
      username: input.username,
      // bigint 不能进 JSON，用十进制字符串过边界（DO 那边再 BigInt() 回来）。
      opCode: input.opCode.toString(),
      data: toBase64(input.data),
      reliable: input.reliable,
      filters: input.filters,
    });
  }

  /**
   * 连接结束：逐条通知本会话加入过的对局（上游 `UntrackAll` 的对局那一半）。
   *
   * 先清清单再通知，理由与频道侧一致：即使某个对局 DO 调用失败，也不会因为"重试一遍"
   * 把清单留在原地。失败只记日志——连接都没了，没有任何客户端可以被告知这次失败。
   */
  async leaveAll(sessionId: string): Promise<void> {
    const rows = this.sql
      .exec<{ readonly match_id: string; readonly uuid: string }>(
        "SELECT match_id, uuid FROM joined_matches ORDER BY match_id",
      )
      .toArray();
    this.sql.exec("DELETE FROM joined_matches");
    if (rows.length === 0) return;
    await Promise.allSettled(
      rows.map((row) => matchLeaveAll(this.env, this.tenantId, row.uuid, sessionId)),
    );
  }

  #record(parts: MatchIdParts): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO joined_matches (match_id, uuid) VALUES (?, ?)",
      `${parts.uuid}.${parts.node}`,
      parts.uuid,
    );
  }

  #forget(parts: MatchIdParts): void {
    this.sql.exec("DELETE FROM joined_matches WHERE match_id = ?", `${parts.uuid}.${parts.node}`);
  }
}

function invalid(message: string): MatchOpResult {
  return { ok: false, failure: { kind: "invalid", message } };
}
