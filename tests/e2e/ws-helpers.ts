import { create } from "@bufbuild/protobuf";

import { RpcSchema } from "../../src/proto/api/api_pb";
import {
  EnvelopeSchema,
  MatchCreateSchema,
  MatchDataSendSchema,
  MatchJoinSchema,
  MatchLeaveSchema,
  MatchmakerAddSchema,
  MatchmakerRemoveSchema,
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
  const cid = envelope.cid === "" ? "" : ` cid=${envelope.cid}`;
  // 错误帧必须把 code 与 message 也打出来：只说"收到一帧 error"，排查就从读日志变成猜。
  if (envelope.message.case === "error") {
    const error = envelope.message.value;
    return `error code=${error.code} message=${error.message}${cid}`;
  }
  return `${envelope.message.case ?? "(空)"}${cid}`;
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

/* ------------------------------------------------------------------ *
 * M7：匹配与对局的帧。E2E 只造客户端**能发**的那六种；`matchmaker_matched`
 * 与 `match_presence_event` 是服务端推的，只能等不能发。
 * ------------------------------------------------------------------ */

export function matchmakerAdd(
  cid: string,
  input: {
    readonly minCount: number;
    readonly maxCount: number;
    readonly query?: string;
    readonly strings?: Readonly<Record<string, string>>;
    readonly numbers?: Readonly<Record<string, number>>;
  },
): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "matchmakerAdd",
      value: create(MatchmakerAddSchema, {
        minCount: input.minCount,
        maxCount: input.maxCount,
        query: input.query ?? "*",
        stringProperties: { ...(input.strings ?? {}) },
        numericProperties: { ...(input.numbers ?? {}) },
      }),
    },
  });
}

export function matchmakerRemove(cid: string, ticket: string): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: { case: "matchmakerRemove", value: create(MatchmakerRemoveSchema, { ticket }) },
  });
}

/** 建一场**中继**对局（`name` 给了就是 v5 派生；权威对局客户端建不了）。 */
export function matchCreate(cid: string, name = ""): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: { case: "matchCreate", value: create(MatchCreateSchema, { name }) },
  });
}

export function matchJoin(cid: string, target: { readonly token?: string; readonly matchId?: string }): Envelope {
  const id =
    target.matchId !== undefined
      ? { case: "matchId" as const, value: target.matchId }
      : { case: "token" as const, value: target.token ?? "" };
  return create(EnvelopeSchema, {
    cid,
    message: { case: "matchJoin", value: create(MatchJoinSchema, { id, metadata: {} }) },
  });
}

export function matchLeave(cid: string, matchId: string): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: { case: "matchLeave", value: create(MatchLeaveSchema, { matchId }) },
  });
}

export function matchDataSend(cid: string, matchId: string, opCode: bigint, data: string): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "matchDataSend",
      value: create(MatchDataSendSchema, {
        matchId,
        opCode,
        data: new TextEncoder().encode(data),
        reliable: true,
      }),
    },
  });
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
