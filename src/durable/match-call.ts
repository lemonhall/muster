/**
 * 会话分片（以及匹配器 DO）→ 对局 DO 的调用封装。
 *
 * 与 `channel-call.ts` 同一个套路：键的拼法集中在这里（`matchKeyOf`），帧的编解码
 * 集中在这里（对局 DO 返回 protojson 帧数组，这里解成 `Envelope`），于是管线只跟
 * 对象打交道，不知道 HTTP 的存在。失败一律抛出——"以为发出去了其实没有"比 500 更糟。
 *
 * 业务失败（对局不存在 / 被拒 / 静默关连接）**不是异常**：原样映射成结果类型，
 * 文案交给管线（它才是那个知道"对局不存在该报什么"的地方）。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_match.go::Pipeline.matchJoin
 *
 * REQ-0001-018
 */

import { fromJson } from "@bufbuild/protobuf";

import type { Bindings } from "../env";
import { matchKeyOf } from "../domain/match/ids";
import { EnvelopeSchema } from "../proto/realtime_pb";
import type { MatchOpFailure, MatchOpResult } from "../realtime/match";

async function matchCall(
  env: Bindings,
  tenantId: string,
  uuid: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const stub = env.MATCH.get(env.MATCH.idFromName(matchKeyOf(tenantId, uuid)));
  const response = await stub.fetch(`https://match${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`对局调用失败：${path} -> ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

function readFailure(raw: unknown): MatchOpFailure {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("对局返回了无法识别的失败体");
  }
  const record = raw as Record<string, unknown>;
  const kind = record["kind"];
  if (kind === "not-found" || kind === "silent") return { kind };
  if (kind === "invalid" && typeof record["message"] === "string") {
    return { kind, message: record["message"] };
  }
  if (kind === "rejected") {
    const reason = record["reason"];
    return { kind, reason: typeof reason === "string" ? reason : "" };
  }
  throw new Error(`对局返回了无法识别的失败类型：${String(kind)}`);
}

/** 一次会改状态的对局操作。 */
export async function matchOp(
  env: Bindings,
  tenantId: string,
  uuid: string,
  path: string,
  body: unknown,
): Promise<MatchOpResult> {
  const raw = await matchCall(env, tenantId, uuid, path, body);
  if (raw["ok"] !== true) return { ok: false, failure: readFailure(raw["failure"]) };
  const replies = raw["replies"];
  if (!Array.isArray(replies)) throw new Error(`对局 ${path} 没有返回帧数组`);
  return { ok: true, replies: replies.map((json) => fromJson(EnvelopeSchema, json as never)) };
}

/** 建一场对局**但不加入任何人**（权威对局的唯一入口，见 ECN-0011 偏差 3）。 */
export async function matchCreate(
  env: Bindings,
  tenantId: string,
  uuid: string,
  input: { readonly authoritative: boolean; readonly label: string | null; readonly node: string },
): Promise<void> {
  await matchCall(env, tenantId, uuid, "/create", input);
}

/** 连接关闭时的对局清理（上游 `UntrackAll` 里对局的那一半）。 */
export async function matchLeaveAll(
  env: Bindings,
  tenantId: string,
  uuid: string,
  sessionId: string,
): Promise<void> {
  await matchCall(env, tenantId, uuid, "/leaveAll", { sessionId });
}
