/**
 * 一条实时会话的元数据：Worker 握手时解析出来，随请求带进分片 DO，
 * 之后一直挂在 WebSocket 上（`serializeAttachment`）。
 *
 * 走 HTTP 头传递是有意的：DO 的 `fetch` 是请求/响应模型，但 WebSocket 升级请求
 * 不能再带 JSON 正文，所以把元数据编成一个 ASCII 安全的头值
 * （base64url(UTF-8 JSON)）——用户名可能是非 ASCII，直接塞头会坏掉。
 *
 * REQ-0001-008, REQ-0001-009
 */

import type { SessionFormat } from "./envelope";

export const SOCKET_META_HEADER = "x-muster-socket-meta";

export interface SocketMeta {
  readonly tenantId: string;
  readonly userId: string;
  readonly username: string;
  readonly sessionId: string;
  readonly format: SessionFormat;
  readonly lang: string;
  readonly wantsStatus: boolean;
  readonly clientIp: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function encodeSocketMeta(meta: SocketMeta): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(meta)));
}

/** 解析失败直接抛错：拿不到会话元数据的连接没有任何可服务的语义。 */
export function decodeSocketMeta(raw: string | null): SocketMeta {
  if (raw === null || raw === "") throw new Error("socket meta header is missing");
  const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(raw)));
  if (typeof parsed !== "object" || parsed === null) throw new Error("socket meta is not an object");
  const meta = parsed as Partial<SocketMeta>;
  for (const key of ["tenantId", "userId", "username", "sessionId", "format", "lang"] as const) {
    if (typeof meta[key] !== "string") throw new Error(`socket meta field ${key} is missing`);
  }
  return {
    tenantId: meta.tenantId as string,
    userId: meta.userId as string,
    username: meta.username as string,
    sessionId: meta.sessionId as string,
    format: meta.format === "protobuf" ? "protobuf" : "json",
    lang: meta.lang as string,
    wantsStatus: meta.wantsStatus === true,
    clientIp: typeof meta.clientIp === "string" ? meta.clientIp : "",
  };
}

/**
 * 分片 DO 的键：**租户 + 会话**。
 *
 * 一个会话一个分片（而不是一个用户一个分片）是刻意的：会话断开只影响它自己，
 * 同一用户的第二个连接不必等第一个的清理；跨租户也天然隔离。
 */
export function shardKeyOf(tenantId: string, sessionId: string): string {
  return `${tenantId}|${sessionId}`;
}
