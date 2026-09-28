/**
 * 对局的四条入站帧：`match_create` / `match_join` / `match_leave` / `match_data_send`。
 *
 * 逐行对齐上游 `server/pipeline_match.go`。四条帧的校验顺序与文案：
 *
 * | 帧 | 顺序 | 失败 |
 * |---|---|---|
 * | create | 无校验（`name` 空则随机 v4） | — |
 * | join | id/token 形状 → uuid 形状 → 服务层（不存在 / 被拒） | `Invalid match ID`、`Invalid match token`、`No match ID or token found`、`Match not found`、`Match join rejected` |
 * | leave | match id 形状 | `Invalid match ID`（其余一律成功） |
 * | data_send | match id 形状（**错误帧不带 cid**） → 过滤器里的 uuid 形状 | `Invalid match ID`；过滤器坏 / 发送者不在场**静默关连接** |
 *
 * 三条反直觉但必须复刻的行为：
 * 1. `match_leave` 与 `match_data_send` 的失败**不都是**"发错误帧"：`data_send` 在
 *    "发送者不是成员"与"过滤器里有坏 uuid"两处都返回 `false, nil`——**一个字节都不发**，
 *    直接关连接；
 * 2. `match_data_send` 的 `Invalid match ID` 错误帧**没有 cid**（上游那一处没设 `Cid`），
 *    而 `match_join` / `match_leave` 的同名错误都带 cid；
 * 3. `match_join` 的 token 分支在解出 mid 之后**仍然**要求 `<uuid>.<node>` 的形状，
 *    形状不对报的是 `Invalid match token` 而**不是** `Invalid match ID`。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_match.go::Pipeline.matchCreate
 * 契约源: server/pipeline_match.go::Pipeline.matchJoin
 * 契约源: server/pipeline_match.go::Pipeline.matchLeave
 * 契约源: server/pipeline_match.go::Pipeline.matchDataSend
 *
 * REQ-0001-018
 */

import { Error_Code, type MatchCreate, type MatchDataSend, type MatchJoin, type MatchLeave } from "../proto/realtime_pb";
import { parseMatchId } from "../domain/match/ids";
import type { MatchDataFilter } from "../domain/match/data";
import { uuidV4, uuidV5, NAMESPACE_DNS } from "../domain/uuid";
import { errorEnvelope } from "./errors";
import { normalizeUserId } from "./identifiers";
import type { MatchOpFailure, MatchOpResult } from "./match";
import type { PipelineContext, PipelineResult } from "./pipeline";

const INVALID_MATCH_ID = "Invalid match ID";
const INVALID_MATCH_TOKEN = "Invalid match token";
const NO_ID_OR_TOKEN = "No match ID or token found";
const UNRECOGNIZED = "Unrecognized match ID or token";
const MATCH_NOT_FOUND = "Match not found";
const JOIN_REJECTED = "Match join rejected";

/** 服务层失败 → 管线结果。文案在这一层定，服务层只说"哪种失败"。 */
function outcome(cid: string, result: MatchOpResult): PipelineResult {
  if (result.ok) return { replies: result.replies, close: false };
  const failure: MatchOpFailure = result.failure;
  switch (failure.kind) {
    case "invalid":
      return fail(cid, Error_Code.BAD_INPUT, failure.message);
    case "not-found":
      return fail(cid, Error_Code.MATCH_NOT_FOUND, MATCH_NOT_FOUND);
    case "rejected":
      return fail(
        cid,
        Error_Code.MATCH_JOIN_REJECTED,
        failure.reason === "" ? JOIN_REJECTED : failure.reason,
      );
    case "silent":
      // 上游 `return false, nil`：没有错误帧，连接直接结束。
      return { replies: [], close: true };
  }
}

function fail(cid: string, code: Error_Code, message: string): PipelineResult {
  return { replies: [errorEnvelope(cid, code, message)], close: true };
}

export async function matchCreate(
  context: PipelineContext,
  cid: string,
  incoming: MatchCreate,
): Promise<PipelineResult> {
  // 有名字 → v5 派生（同名同局）；没名字 → 随机。两者都拼成中继对局的 `<uuid>.`。
  const uuid = incoming.name === "" ? uuidV4() : await uuidV5(NAMESPACE_DNS, incoming.name);
  return outcome(
    cid,
    await context.match.create({
      cid,
      sessionId: context.sessionId,
      userId: context.userId,
      username: context.username,
      matchId: `${uuid}.`,
      named: incoming.name !== "",
    }),
  );
}

export async function matchJoin(
  context: PipelineContext,
  cid: string,
  incoming: MatchJoin,
): Promise<PipelineResult> {
  let matchId: string;
  let allowEmpty = false;

  if (incoming.id.case === "matchId") {
    matchId = incoming.id.value;
    if (parseMatchId(matchId) === null) return fail(cid, Error_Code.BAD_INPUT, INVALID_MATCH_ID);
  } else if (incoming.id.case === "token") {
    const mid = await context.match.resolveToken(incoming.id.value);
    // 验签失败与"解出来的 mid 形状不对"共用同一条文案（上游也是两处都报它）。
    if (mid === null || parseMatchId(mid) === null) {
      return fail(cid, Error_Code.BAD_INPUT, INVALID_MATCH_TOKEN);
    }
    matchId = mid;
    // token 分支允许"对局还不存在"——它本身就是"该新建一场中继对局"的指令。
    allowEmpty = true;
  } else if (incoming.id.case === undefined) {
    return fail(cid, Error_Code.BAD_INPUT, NO_ID_OR_TOKEN);
  } else {
    // 生成物里 `id` 只有两个分支，这个 else 是给"协议加了第三种 id"留的对账位。
    return fail(cid, Error_Code.BAD_INPUT, UNRECOGNIZED);
  }

  return outcome(
    cid,
    await context.match.join({
      cid,
      sessionId: context.sessionId,
      userId: context.userId,
      username: context.username,
      matchId,
      allowEmpty,
      metadata: incoming.metadata,
    }),
  );
}

export async function matchLeave(
  context: PipelineContext,
  cid: string,
  incoming: MatchLeave,
): Promise<PipelineResult> {
  if (parseMatchId(incoming.matchId) === null) {
    return fail(cid, Error_Code.BAD_INPUT, INVALID_MATCH_ID);
  }
  return outcome(
    cid,
    await context.match.leave({
      cid,
      sessionId: context.sessionId,
      userId: context.userId,
      username: context.username,
      matchId: incoming.matchId,
    }),
  );
}

export async function matchDataSend(
  context: PipelineContext,
  cid: string,
  incoming: MatchDataSend,
): Promise<PipelineResult> {
  // 注意：上游这一处**不带 cid**（`&rtapi.Envelope{Message: ...}`）。
  if (parseMatchId(incoming.matchId) === null) {
    return fail("", Error_Code.BAD_INPUT, INVALID_MATCH_ID);
  }

  const filters: MatchDataFilter[] = [];
  for (const presence of incoming.presences) {
    const userId = normalizeUserId(presence.userId);
    const sessionId = normalizeUserId(presence.sessionId);
    // 过滤器里有一个解不开的 uuid：上游 `return false, nil`——静默关连接。
    if (userId === null || sessionId === null) return { replies: [], close: true };
    filters.push({ userId, sessionId });
  }

  return outcome(
    cid,
    await context.match.dataSend({
      sessionId: context.sessionId,
      userId: context.userId,
      username: context.username,
      matchId: incoming.matchId,
      opCode: incoming.opCode,
      data: incoming.data,
      reliable: incoming.reliable,
      filters,
    }),
  );
}
