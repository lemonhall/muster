/**
 * 会话分片 DO：**一个 WebSocket 会话一个实例**，负责这条连接的收发与生命周期。
 *
 * 为什么是"会话"而不是"用户"：会话断开只需要影响它自己；同一用户的第二条连接
 * 不必等第一条清理完。键是 `tenantId|sessionId`，跨租户天然隔离。
 *
 * 用 Cloudflare 的 WebSocket Hibernation API（`ctx.acceptWebSocket`）：空闲会话不占
 * 内存也不烧时长，被唤醒时元数据从 `serializeAttachment` 里恢复。分片本身不做业务
 * 判断——语义都在 `src/realtime/pipeline.ts`，它只负责"字节进、字节出、该关就关"。
 *
 * 与上游 `sessionWS.consume` 对齐的三条硬规矩：
 * 1. 帧类型必须与协商的格式一致（json ↔ 文本帧、protobuf ↔ 二进制帧），混用就断开；
 * 2. 畸形帧不宽容：断开连接（不是回一个错误帧继续）；
 * 3. 管线说"关"就关：先把手上的回执发完，再用关闭帧结束（上游 Close 的等价物）。
 *
 * 契约源（机器可读）：
 * 契约源: server/session_ws.go::sessionWS.consume
 * 契约源: server/session_ws.go::sessionWS.Close
 *
 * REQ-0001-008, REQ-0001-009
 */

import { DurableObject } from "cloudflare:workers";

import type { Bindings } from "../env";
import { decodeEnvelope, encodeEnvelope, type SessionFormat } from "../realtime/envelope";
import { handleEnvelope, type PipelineContext, type StatusService } from "../realtime/pipeline";
import {
  statusPresenceEventEnvelope,
  type PresenceSnapshot,
} from "../realtime/presence";
import { decodeSocketMeta, SOCKET_META_HEADER, type SocketMeta } from "../realtime/socket-meta";
import { registryCall, registryFollow } from "./registry-call";

const decoder = new TextDecoder();

/**
 * 心跳周期：只要这条连接还活着，就每隔这么久跟注册表说一声"我还在"。
 *
 * 上游靠 **WS 控制帧 ping（默认 15s）+ 读超时（默认 25s）** 判活性，而 Workers 的
 * Durable Object WebSocket 不把控制帧交给我们（平台自己管），所以这里换成应用层等价物：
 * 分片定期 `/touch` 注册表，注册表超过 3 个周期没收到就把它当作离线清理掉。
 *
 * 为什么不直接"25s 没收到入站帧就断连"：上游的客户端能活下来，是因为**服务端先发了
 * ping**、浏览器栈自动回 pong；我们发不出控制 ping，照抄这条会把"没人说话的健康连接"
 * 全误杀。所以心跳只用来维持"在线"这个判断，不用来断连。
 */
export const SESSION_TOUCH_INTERVAL_MS = 20_000;

export class SessionShard extends DurableObject<Bindings> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/deliver") {
      await this.#deliver((await request.json()) as Delivery);
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }
    return await this.#accept(request);
  }

  async #accept(request: Request): Promise<Response> {
    const meta = decodeSocketMeta(request.headers.get(SOCKET_META_HEADER));
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(meta);

    // 先把"我上线了"记进注册表，再把手交回给客户端：否则客户端紧接着发
    // `status_follow` 时，注册表可能还不知道这条会话存在，事件就会漏。
    await registryCall(this.env, meta.tenantId, "/connect", {
      sessionId: meta.sessionId,
      userId: meta.userId,
      username: meta.username,
      wantsStatus: meta.wantsStatus,
    });
    await this.#ensureTouchAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  /** 定期告诉注册表"这条会话还在"。没有连接了就彻底停掉闹钟，别让 DO 空转。 */
  override async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    for (const socket of sockets) {
      const meta = socket.deserializeAttachment() as SocketMeta | null;
      if (meta === null) continue;
      await registryCall(this.env, meta.tenantId, "/touch", { sessionId: meta.sessionId });
    }
    await this.ctx.storage.setAlarm(Date.now() + SESSION_TOUCH_INTERVAL_MS);
  }

  /**
   * 注册表推来的上下线事件 → 连接上的 `status_presence_event`。
   * 事件没有 cid（上游发这类通知时也不带）。
   */
  async #deliver(delivery: Delivery): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      const meta = socket.deserializeAttachment() as SocketMeta | null;
      if (meta === null) continue;
      const envelope = statusPresenceEventEnvelope(delivery.joins, delivery.leaves);
      socket.send(encodeFor(meta.format, envelope));
    }
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const meta = socket.deserializeAttachment() as SocketMeta | null;
    if (meta === null) return;

    const isText = typeof message === "string";
    if (isText !== (meta.format === "json")) {
      await this.#close(socket, meta, "received unexpected WebSocket message type");
      return;
    }

    const bytes =
      typeof message === "string" ? new TextEncoder().encode(message) : new Uint8Array(message);

    let envelope;
    try {
      envelope = decodeEnvelope(bytes, meta.format);
    } catch {
      await this.#close(socket, meta, "received malformed payload");
      return;
    }

    const result = await handleEnvelope(this.#context(meta), envelope);
    for (const reply of result.replies) socket.send(encodeFor(meta.format, reply));

    if (result.close) {
      await this.#close(socket, meta, "error processing message");
      return;
    }
    await this.#touch(meta);
  }

  override async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    void code;
    void reason;
    void wasClean;
    const meta = socket.deserializeAttachment() as SocketMeta | null;
    if (meta === null) return;
    await this.#disconnect(meta);
    await this.#retireTouchAlarm();
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    const meta = socket.deserializeAttachment() as SocketMeta | null;
    if (meta === null) return;
    await this.#disconnect(meta);
    await this.#retireTouchAlarm();
  }

  async #ensureTouchAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + SESSION_TOUCH_INTERVAL_MS);
    }
  }

  /** 关掉最后一个连接之后就没有再唤醒自己的理由（闹钟会阻止 DO 进入空闲）。 */
  async #retireTouchAlarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) await this.ctx.storage.deleteAlarm();
  }

  #context(meta: SocketMeta): PipelineContext {
    return {
      db: this.env.DB,
      tenantId: meta.tenantId,
      sessionId: meta.sessionId,
      userId: meta.userId,
      username: meta.username,
      status: this.#statusService(meta),
    };
  }

  #statusService(meta: SocketMeta): StatusService {
    return {
      follow: (sessionId, userIds) =>
        registryFollow(this.env, meta.tenantId, sessionId, userIds),
      unfollow: async (sessionId, userIds) => {
        await registryCall(this.env, meta.tenantId, "/unfollow", { sessionId, userIds });
      },
      publish: async (sessionId, userId, username, status) => {
        await registryCall(this.env, meta.tenantId, "/status", {
          sessionId,
          userId,
          username,
          wantsStatus: true,
          status,
        });
      },
    };
  }

  async #touch(meta: SocketMeta): Promise<void> {
    await registryCall(this.env, meta.tenantId, "/touch", { sessionId: meta.sessionId });
  }

  /** 幂等：先发关闭帧的路径与客户端自己断开，都会走到这里，注册表只该感知一次。 */
  async #disconnect(meta: SocketMeta): Promise<void> {
    try {
      await registryCall(this.env, meta.tenantId, "/disconnect", { sessionId: meta.sessionId });
    } catch (error) {
      console.error("会话注册表清理失败", error);
    }
  }

  async #close(socket: WebSocket, meta: SocketMeta, reason: string): Promise<void> {
    await this.#disconnect(meta);
    try {
      socket.close(1000, reason);
    } catch {
      // 连接可能已经被对端关掉了；关闭失败不影响"这条会话已经结束"这个事实。
    }
  }
}

function encodeFor(format: SessionFormat, envelope: Parameters<typeof encodeEnvelope>[0]): string | ArrayBuffer {
  const bytes = encodeEnvelope(envelope, format);
  if (format === "json") return decoder.decode(bytes);
  // 复制到独立的 ArrayBuffer：workerd 不接受视图内部偏移的视图直接发送。
  return bytes.slice().buffer;
}

interface Delivery {
  readonly joins: readonly PresenceSnapshot[];
  readonly leaves: readonly PresenceSnapshot[];
}
