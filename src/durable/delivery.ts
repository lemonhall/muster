/**
 * DO 之间"把一帧送到某条会话"的唯一通道。
 *
 * 谁需要它：注册表 DO（上下线事件）与频道 DO（presence 事件、频道消息）都必须把帧
 * 交给**连接所在的会话分片**，而 DO 之间只能通过 `fetch` 说话。帧本身是 protobuf
 * 消息，跨 HTTP 就得先挑一种表示：这里用 protojson（`toJson`/`fromJson`），
 * 于是投递体是**人能读的 JSON**——排查"某条会话到底收到了什么"时可以直接打印。
 *
 * 为什么带 `sessionId`：分片虽然本来就是"一条会话一个实例"，但收件人字段是
 * 一次廉价的防串线校验（`shardKeyOf` 拼错了会立刻暴露），也让日志有主语。
 * 线格式（`json` / `protobuf`）**不在**这里决定：那是分片的职责，它按每条连接
 * 协商的格式编码（`socket.serializeAttachment()` 里的 `format`）。
 *
 * REQ-0001-009, REQ-0001-010
 */

import { fromJson, toJson } from "@bufbuild/protobuf";

import type { Bindings } from "../env";
import { EnvelopeSchema, type Envelope } from "../proto/realtime_pb";
import { shardKeyOf } from "../realtime/socket-meta";

export const DELIVER_PATH = "/deliver";

export interface Delivery {
  readonly sessionId: string;
  readonly envelope: Envelope;
}

/** 投递体的线格式：`{ sessionId, envelope: <protojson> }`。 */
export function deliveryBody(sessionId: string, envelope: Envelope): string {
  return JSON.stringify({ sessionId, envelope: toJson(EnvelopeSchema, envelope) });
}

/** 解析投递体。形状不对就抛错——分片宁可 500，也不能把半条帧发上线。 */
export function parseDelivery(raw: unknown): Delivery {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("delivery body must be an object");
  }
  const body = raw as Record<string, unknown>;
  const sessionId = body["sessionId"];
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new Error("delivery sessionId is missing");
  }
  return { sessionId, envelope: fromJson(EnvelopeSchema, body["envelope"] as never) };
}

/**
 * 把一帧送到某条会话所在的分片。
 *
 * 失败一律抛出，由调用方决定是"整批失败"还是 `allSettled` 后记日志：
 * 投递失败意味着某个客户端会漏掉一条事件，静默吞掉就会变成难查的"偶发丢帧"。
 */
export async function deliverToSession(
  env: Bindings,
  tenantId: string,
  sessionId: string,
  envelope: Envelope,
): Promise<void> {
  const stub = env.SESSION_SHARD.get(env.SESSION_SHARD.idFromName(shardKeyOf(tenantId, sessionId)));
  const response = await stub.fetch(`https://shard${DELIVER_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: deliveryBody(sessionId, envelope),
  });
  if (!response.ok) {
    throw new Error(`投递帧到会话 ${sessionId} 失败：${response.status}`);
  }
}
