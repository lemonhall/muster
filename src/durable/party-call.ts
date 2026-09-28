/**
 * 会话分片 → 派对 DO 的调用封装。
 *
 * 键的拼法集中在这里（`partyKeyOf`），帧的编解码集中在这里（派对 DO 返回
 * protojson 帧数组，这里解成 `Envelope`），于是管线只跟对象打交道，
 * 不知道 HTTP 的存在。失败一律抛出——"以为发出去了其实没有"比 500 更糟。
 *
 * 业务失败**不是异常**：`{code:"party"|"text"}` 那两支原样映射成结果类型，
 * 文案交给管线（它才是那个知道"该加哪个前缀"的地方）。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_party.go::Pipeline.partyJoin
 * 契约源: server/party_registry.go::LocalPartyRegistry.PartyJoinRequest
 *
 * REQ-0001-019
 */

import { fromJson } from "@bufbuild/protobuf";

import type { Bindings } from "../env";
import { partyKeyOf } from "../domain/party/ids";
import type { PartyFailureKind } from "../domain/party/errors";
import { failureText } from "../domain/party/errors";
import { EnvelopeSchema } from "../proto/realtime_pb";
import type { PartyOpFailure, PartyOpResult } from "../realtime/party";

async function partyCall(
  env: Bindings,
  tenantId: string,
  uuid: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const stub = env.PARTY.get(env.PARTY.idFromName(partyKeyOf(tenantId, uuid)));
  const response = await stub.fetch(`https://party${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`派对调用失败：${path} -> ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

/** 派对 DO 的失败体只有两种形状，别的一律当协议错误炸掉。 */
function readFailure(raw: unknown): PartyOpFailure {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("派对返回了无法识别的失败体");
  }
  const record = raw as Record<string, unknown>;
  const code = record["code"];
  if (code === "party") {
    const reason = record["reason"];
    if (typeof reason !== "string" || failureText(reason as PartyFailureKind) === undefined) {
      throw new Error(`派对返回了无法识别的失败原因：${String(reason)}`);
    }
    return { code: "party", reason: reason as PartyFailureKind };
  }
  if (code === "text") {
    const message = record["message"];
    if (typeof message !== "string") throw new Error("派对失败体缺少 message");
    return { code: "text", message };
  }
  throw new Error(`派对返回了无法识别的失败类型：${String(code)}`);
}

/** 一次会改状态的派对操作。 */
export async function partyOp(
  env: Bindings,
  tenantId: string,
  uuid: string,
  path: string,
  body: unknown,
): Promise<PartyOpResult> {
  const raw = await partyCall(env, tenantId, uuid, path, body);
  if (raw["ok"] !== true) return { ok: false, failure: readFailure(raw["failure"]) };
  const replies = raw["replies"];
  if (!Array.isArray(replies)) throw new Error(`派对 ${path} 没有返回帧数组`);
  return { ok: true, replies: replies.map((json) => fromJson(EnvelopeSchema, json as never)) };
}

/** 连接关闭时的派对清理（上游 `UntrackAll` 的派对那一半）。 */
export async function partyLeaveAll(
  env: Bindings,
  tenantId: string,
  uuid: string,
  sessionId: string,
): Promise<void> {
  await partyCall(env, tenantId, uuid, "/leaveAll", { sessionId });
}

/** 派对是否存在（踢人/退出之后用来决定要不要把它从会话的清单里划掉）。 */
export async function partyExists(env: Bindings, tenantId: string, uuid: string): Promise<boolean> {
  const raw = await partyCall(env, tenantId, uuid, "/exists", {});
  return raw["exists"] === true;
}
