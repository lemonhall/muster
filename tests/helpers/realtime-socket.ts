import { env } from "cloudflare:test";

import { decodeEnvelope, encodeEnvelope, type SessionFormat } from "../../src/realtime/envelope";
import { SOCKET_META_HEADER, encodeSocketMeta, shardKeyOf } from "../../src/realtime/socket-meta";
import type { Envelope, UserPresence } from "../../src/proto/realtime_pb";

/**
 * M3 实时套件的第二条工装：**真的**开一条 WebSocket 到会话分片 DO，并收集收到的帧。
 *
 * 走的是真实路径：`SESSION_SHARD` 绑定的 DO stub + `Upgrade: websocket`，
 * 分片内部的 `ctx.acceptWebSocket` 与注册表回调全部真实发生。
 * 全程在本机 workerd 内，不连任何线上资源。
 *
 * 文件名不带 `.test.ts`，不会被 vitest 收集。
 */

const encoder = new TextEncoder();

export interface TestSocket {
  readonly sessionId: string;
  readonly format: SessionFormat;
  readonly socket: WebSocket;
  readonly frames: Envelope[];
  close(): void;
}

export async function openSocket(
  tenantId: string,
  sessionId: string,
  userId: string,
  username: string,
  options: { readonly format?: SessionFormat; readonly wantsStatus?: boolean } = {},
): Promise<TestSocket> {
  const format = options.format ?? "json";
  const stub = env.SESSION_SHARD.get(env.SESSION_SHARD.idFromName(shardKeyOf(tenantId, sessionId)));
  const response = await stub.fetch("https://shard/connect", {
    headers: {
      upgrade: "websocket",
      [SOCKET_META_HEADER]: encodeSocketMeta({
        tenantId,
        userId,
        username,
        sessionId,
        format,
        lang: "en",
        wantsStatus: options.wantsStatus ?? true,
        clientIp: "127.0.0.1",
      }),
    },
  });
  const socket = response.webSocket;
  if (socket === null) throw new Error(`分片没有升级出 WebSocket（HTTP ${response.status}）`);

  const frames: Envelope[] = [];
  // 先挂监听再 accept：升级之后服务端可能立刻推帧，晚挂就会丢。
  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data === "string") frames.push(decodeEnvelope(encoder.encode(event.data), format));
    else frames.push(decodeEnvelope(new Uint8Array(event.data as ArrayBuffer), format));
  });
  socket.accept();

  return {
    sessionId,
    format,
    socket,
    frames,
    close: () => socket.close(1000, "test finished"),
  };
}

/**
 * 从测试这一侧发一帧：与真实客户端走**同一条路**（对象 → 线格式字节 → 文本/二进制帧），
 * 而不是在测试里手拼 JSON 字符串——手拼就测不到编码这一层。
 */
export function sendFrame(target: TestSocket, envelope: Envelope): void {
  const bytes = encodeEnvelope(envelope, target.format);
  // 线格式决定帧类型：json 走文本帧、protobuf 走二进制帧。发错类型会被分片判成畸形帧并断开
  // （`webSocketMessage` 里那条 `isText !== (format === "json")`），所以这里必须与之一致。
  if (target.format === "json") target.socket.send(new TextDecoder().decode(bytes));
  else target.socket.send(bytes);
}

/** 给注册表 DO 发一条指令，返回解析后的 JSON。 */
export async function registryPost<T>(
  tenantId: string,
  path: string,
  body: unknown,
): Promise<T> {
  const stub = env.SESSION_REGISTRY.get(env.SESSION_REGISTRY.idFromName(tenantId));
  const response = await stub.fetch(`https://registry${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`注册表 ${path} 返回 ${response.status}`);
  return (await response.json()) as T;
}

/** 等一条满足条件的帧；超时就把已收到的帧全打出来，省得靠猜。 */
export async function waitForFrame(
  target: TestSocket,
  predicate: (envelope: Envelope) => boolean,
  timeoutMs = 3000,
): Promise<Envelope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = target.frames.find(predicate);
    if (hit !== undefined) return hit;
    await delay(10);
  }
  throw new Error(
    `${timeoutMs}ms 内没等到目标帧。已收到：${target.frames.map(describe).join(" | ") || "(空)"}`,
  );
}

/** 有界等待后仍为 0 才能说"没有"——负向断言不能只看当前快照。 */
export async function expectNoFrame(
  target: TestSocket,
  predicate: (envelope: Envelope) => boolean,
  windowMs = 200,
): Promise<void> {
  await delay(windowMs);
  const hit = target.frames.find(predicate);
  if (hit !== undefined) throw new Error(`本不该收到这帧：${describe(hit)}`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 断言"从这一刻起**不再有新的**匹配帧"。
 *
 * 与 `expectNoFrame` 的区别很要紧：帧列表是**历史**。一条会话先收过自己的加入事件、
 * 之后才进入"本不该再收到事件"的阶段时，`expectNoFrame` 会因为那段历史而误报。
 * 所以负向断言先钉住基线条数，再等一个有界窗口比条数。
 */
export async function expectNoNewFrame(
  target: TestSocket,
  predicate: (envelope: Envelope) => boolean,
  windowMs = 200,
): Promise<void> {
  const before = target.frames.filter(predicate).length;
  await delay(windowMs);
  const matched = target.frames.filter(predicate);
  if (matched.length !== before) {
    throw new Error(`本不该再收到这帧：${describe(matched[matched.length - 1] as Envelope)}`);
  }
}

function describe(envelope: Envelope): string {
  return `${envelope.message.case ?? "(空)"}${envelope.cid === "" ? "" : ` cid=${envelope.cid}`}`;
}

/** `status_presence_event` 的 joins/leaves → `user/session/status` 字符串表。 */
export function eventKeys(envelope: Envelope): { joins: string[]; leaves: string[] } {
  if (envelope.message.case !== "statusPresenceEvent") {
    throw new Error(`期望 status_presence_event，实际是 ${envelope.message.case ?? "(空)"}`);
  }
  const render = (presence: UserPresence): string =>
    `${presence.userId}/${presence.sessionId}/${presence.status ?? ""}`;
  return {
    joins: envelope.message.value.joins.map(render),
    leaves: envelope.message.value.leaves.map(render),
  };
}

/** `Status{presences}` → `user/session/status` 字符串表。 */
export function statusKeys(envelope: Envelope): string[] {
  if (envelope.message.case !== "status") {
    throw new Error(`期望 status，实际是 ${envelope.message.case ?? "(空)"}`);
  }
  return envelope.message.value.presences.map(
    (presence) => `${presence.userId}/${presence.sessionId}/${presence.status ?? ""}`,
  );
}
