/**
 * 会话分片 → 频道 DO 的调用封装。
 *
 * 与 `registry-call.ts` 同一个套路：把"路径 + JSON 进 / JSON 出"收成一个函数，
 * 但这里多两件事：
 *
 * 1. **键的拼法集中在这里**（`channelKeyOf`）：租户与频道的分隔符只此一处，
 *    免得某个调用点写成 `频道|租户` 而把两个频道混成一个；
 * 2. **帧的编解码集中在这里**：频道 DO 返回的是 protojson 帧数组，这一层把它解成
 *    `Envelope`，于是管线只跟对象打交道，不知道 HTTP 的存在。
 *
 * 失败一律抛出（不再假装成功）：客户端如果以为消息发出去了而其实没有，比收到 500 更糟。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_channel.go::Pipeline.channelJoin
 *
 * REQ-0001-010
 */

import { fromJson } from "@bufbuild/protobuf";

import type { Bindings } from "../env";
import { EnvelopeSchema } from "../proto/realtime_pb";
import type { ChannelOpResult } from "../realtime/channel";

/** 频道 DO 的键：**租户 + 频道 id**（跨租户隔离靠它，不靠 SQL 里的列）。 */
export function channelKeyOf(tenantId: string, channelId: string): string {
  return `${tenantId}|${channelId}`;
}

async function channelCall(
  env: Bindings,
  tenantId: string,
  channelId: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const stub = env.CHANNEL.get(env.CHANNEL.idFromName(channelKeyOf(tenantId, channelId)));
  const response = await stub.fetch(`https://channel${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`频道调用失败：${path} -> ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

/**
 * 一次会改状态的操作（join/leave/send/update/remove）。
 * 失败是**业务失败**（未加入频道、消息不存在），不是异常：原样映射成结果类型。
 */
export async function channelOp(
  env: Bindings,
  tenantId: string,
  channelId: string,
  path: string,
  body: unknown,
): Promise<ChannelOpResult> {
  const raw = await channelCall(env, tenantId, channelId, path, body);
  if (raw["ok"] !== true) {
    const code = raw["code"];
    const message = raw["message"];
    if ((code !== "BAD_INPUT" && code !== "RUNTIME_EXCEPTION") || typeof message !== "string") {
      throw new Error(`频道 ${path} 返回了无法识别的失败体`);
    }
    return { ok: false, code, message };
  }
  const replies = raw["replies"];
  if (!Array.isArray(replies)) throw new Error(`频道 ${path} 没有返回帧数组`);
  return { ok: true, replies: replies.map((json) => fromJson(EnvelopeSchema, json as never)) };
}

export interface ChannelPageRequest {
  readonly limit: number;
  readonly forward: boolean;
  readonly cursor: string;
  /** 读历史的人：准入判定（群组成员 / 私聊参与者）要用它。 */
  readonly callerId: string;
}

/** 三种拒绝理由，与上游 `ChannelMessagesList` 的三条错误一一对应（文案在 REST 层）。 */
export type ChannelPageDenial = "cursor" | "group" | "channel";

export type ChannelPageResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly reason: ChannelPageDenial };

/** 读历史：成功时把**已经按 protojson 形状拼好**的响应体交回 REST 层。 */
export async function channelPage(
  env: Bindings,
  tenantId: string,
  channelId: string,
  request: ChannelPageRequest,
): Promise<ChannelPageResult> {
  const raw = await channelCall(env, tenantId, channelId, "/list", request);
  if (raw["ok"] !== true) {
    const reason = raw["reason"];
    if (reason !== "cursor" && reason !== "group" && reason !== "channel") {
      throw new Error("频道 /list 返回了无法识别的拒绝理由");
    }
    return { ok: false, reason };
  }
  const body = raw["body"];
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("频道 /list 返回了无法识别的响应体");
  }
  return { ok: true, body: body as Record<string, unknown> };
}
