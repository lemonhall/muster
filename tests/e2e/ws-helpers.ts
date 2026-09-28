import { create } from "@bufbuild/protobuf";

import { RpcSchema } from "../../src/proto/api/api_pb";
import {
  EnvelopeSchema,
  PingSchema,
  StatusFollowSchema,
  StatusUnfollowSchema,
  StatusUpdateSchema,
  type Envelope,
  type UserPresence,
} from "../../src/proto/realtime_pb";
import { decodeEnvelope, encodeEnvelope, type SessionFormat } from "../../src/realtime/envelope";
import { baseUrl } from "./http-helpers";

/**
 * E2E 的 WebSocket 工装：用**真客户端**连到本地 `wrangler dev` 的 `/ws`。
 *
 * 为什么用查询参数传令牌而不是 `Authorization` 头：Node 的 `WebSocket` 是 undici 实现，
 * 构造函数只保证 WHATWG 的标准参数，而查询参数这条路本来就是上游 SDK 的等价写法
 * （见 `src/realtime/handshake.ts`），走它就不依赖 undici 的扩展选项了。
 *
 * 文件名不带 `.e2e.test.ts`，不会被 vitest 收集。
 */

export interface WsClient {
  readonly frames: Envelope[];
  send(envelope: Envelope): void;
  waitForFrame(predicate: (envelope: Envelope) => boolean, timeoutMs?: number): Promise<Envelope>;
  close(): void;
}

export async function connectSocket(
  token: string,
  options: { readonly format?: SessionFormat; readonly status?: boolean } = {},
): Promise<WsClient> {
  const format = options.format ?? "json";
  const query = new URLSearchParams({
    token,
    format,
    status: (options.status ?? true) ? "true" : "false",
  });
  const url = `${baseUrl.replace(/^http/, "ws")}/ws?${query.toString()}`;

  const socket = new WebSocket(url);
  // undici 默认把二进制帧交成 Blob；本项目要按字节解 protobuf，所以显式要 ArrayBuffer。
  socket.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error(`WebSocket 未能连上 ${url}`)), {
      once: true,
    });
  });

  const frames: Envelope[] = [];
  socket.addEventListener("message", (event: MessageEvent) => {
    const data = event.data;
    if (typeof data === "string") frames.push(decodeEnvelope(new TextEncoder().encode(data), format));
    else frames.push(decodeEnvelope(new Uint8Array(data as ArrayBuffer), format));
  });

  return {
    frames,
    send: (envelope) => {
      const bytes = encodeEnvelope(envelope, format);
      if (format === "json") socket.send(new TextDecoder().decode(bytes));
      else socket.send(bytes);
    },
    waitForFrame: (predicate, timeoutMs = 5000) => waitForFrame(frames, predicate, timeoutMs),
    close: () => socket.close(1000, "e2e finished"),
  };
}

/** 轮询式等待：E2E 里失败要能给出"已经收到了什么"，不然只能靠盯日志。 */
export async function waitForFrame(
  frames: readonly Envelope[],
  predicate: (envelope: Envelope) => boolean,
  timeoutMs: number,
): Promise<Envelope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = frames.find(predicate);
    if (hit !== undefined) return hit;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `${timeoutMs}ms 内没等到目标帧。已收到：${frames.map(describe).join(" | ") || "(空)"}`,
  );
}

function describe(envelope: Envelope): string {
  return `${envelope.message.case ?? "(空)"}${envelope.cid === "" ? "" : ` cid=${envelope.cid}`}`;
}

export function ping(cid: string): Envelope {
  return create(EnvelopeSchema, { cid, message: { case: "ping", value: create(PingSchema, {}) } });
}

export function statusFollow(cid: string, userIds: readonly string[]): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: { case: "statusFollow", value: create(StatusFollowSchema, { userIds: [...userIds] }) },
  });
}

export function statusUnfollow(cid: string, userIds: readonly string[]): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "statusUnfollow",
      value: create(StatusUnfollowSchema, { userIds: [...userIds] }),
    },
  });
}

export function statusUpdate(cid: string, status?: string): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "statusUpdate",
      value: create(StatusUpdateSchema, status === undefined ? {} : { status }),
    },
  });
}

/** 一个 M3 还没接通的类型（M6 会接通）：用来验证"错误帧仍带 cid 且随后断开"。 */
export function rpc(cid: string): Envelope {
  return create(EnvelopeSchema, { cid, message: { case: "rpc", value: create(RpcSchema, { id: "e2e" }) } });
}

export function presenceKeys(envelope: Envelope): { joins: string[]; leaves: string[] } {
  if (envelope.message.case !== "statusPresenceEvent") {
    throw new Error(`期望 status_presence_event，实际是 ${envelope.message.case ?? "(空)"}`);
  }
  const render = (presence: UserPresence): string =>
    `${presence.userId}/${presence.status ?? ""}`;
  return {
    joins: envelope.message.value.joins.map(render),
    leaves: envelope.message.value.leaves.map(render),
  };
}

export function statusKeys(envelope: Envelope): string[] {
  if (envelope.message.case !== "status") {
    throw new Error(`期望 status，实际是 ${envelope.message.case ?? "(空)"}`);
  }
  return envelope.message.value.presences.map(
    (presence) => `${presence.userId}/${presence.status ?? ""}`,
  );
}
