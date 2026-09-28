/**
 * `/ws` 路由：握手 → 交给会话分片 DO。
 *
 * 这一层只做三件事：鉴权、把会话元数据打包、把请求转给分片。
 * **真正的 WebSocket 在 DO 里建立**——Worker 是无状态的，连接必须挂在有状态的
 * 分片上才能跨请求活着（这也是 Cloudflare 官方推荐的写法）。
 *
 * 注意 `/ws` 不在上游的 REST 表里：上游把 socket 端口与 API 端口分开监听，
 * 本项目把两者合在同一个 Worker 上（见 ECN-0006），因此这里用 `handlePublic`
 * 注册，不参与 REST 对账。
 *
 * 契约源（机器可读）：
 * 契约源: server/socket_ws.go::NewSocketWsAcceptor
 *
 * REQ-0001-008
 */

import type { Bindings } from "../../env";
import { nowSeconds } from "../auth";
import { HandshakeRejection, authenticateSocketHandshake } from "../../realtime/handshake";
import { SOCKET_META_HEADER, encodeSocketMeta, shardKeyOf } from "../../realtime/socket-meta";
import type { Router } from "../router";

export function registerSocketRoutes(router: Router): void {
  router.handlePublic("GET", "/ws", async ({ env, request, url }) => {
    let handshake;
    try {
      handshake = await authenticateSocketHandshake(env, request, url, nowSeconds());
    } catch (error) {
      if (error instanceof HandshakeRejection) return error.toResponse();
      throw error;
    }

    const meta = {
      tenantId: handshake.tenantEnv.tenantId,
      userId: handshake.session.claims.uid,
      username: handshake.session.claims.usn,
      sessionId: handshake.sessionId,
      format: handshake.format,
      lang: handshake.lang,
      wantsStatus: handshake.wantsStatus,
      clientIp: handshake.clientIp,
    };

    return await forwardToShard(env, meta);
  });
}

async function forwardToShard(
  env: Bindings,
  meta: Parameters<typeof encodeSocketMeta>[0],
): Promise<Response> {
  const stub = env.SESSION_SHARD.get(
    env.SESSION_SHARD.idFromName(shardKeyOf(meta.tenantId, meta.sessionId)),
  );
  const forwarded = new Request("https://shard/connect", {
    headers: {
      upgrade: "websocket",
      [SOCKET_META_HEADER]: encodeSocketMeta(meta),
    },
  });
  return await stub.fetch(forwarded);
}
