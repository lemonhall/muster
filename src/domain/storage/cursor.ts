/**
 * 存储列表的游标。
 *
 * **游标是客户端不可解析的不透明令牌**——这是唯一的契约。上游用 Go 的 `encoding/gob`
 * 序列化 `storageCursor{Key, UserID, Read}` 再做 base64url，我们这边显然无法也不该
 * 复刻 gob 字节流，于是改成 base64url(JSON)。客户端拿到什么就传回什么，两边都不受影响。
 * 差异已登记：[ECN-0004](../../../docs/ecn/ECN-0004-storage-cursor-encoding.md)。
 *
 * 与上游一致的三条可观测行为（这些才是契约）：
 *   1. 非法游标 → `400 {"code":3,"message":"Malformed cursor was used."}`；
 *   2. 游标里的定位信息是"上一页最后一个对象"，下一页从**严格大于**它开始；
 *   3. 反向不变量：如果服务端算出来的游标与请求里的游标相同，就返回空游标（上游
 *      `StorageListObjects` 末尾那一句），避免客户端拿到一个"翻不动"的游标死循环。
 */

import { invalidArgument } from "../../http/errors";

export interface StorageCursor {
  readonly read: number;
  readonly key: string;
  readonly userId: string;
}

const MAX_CURSOR_LENGTH = 4096;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

export function encodeCursor(cursor: StorageCursor): string {
  return toBase64Url(JSON.stringify({ r: cursor.read, k: cursor.key, u: cursor.userId }));
}

/**
 * 解码游标。任何形状不对的输入都报上游同一句话，不区分"base64 坏了"还是"字段缺失"——
 * 上游也一样：先 base64 失败、再 gob 失败，对外都是 `Malformed cursor was used.`。
 */
export function decodeCursor(raw: string): StorageCursor {
  if (raw.length > MAX_CURSOR_LENGTH) throw invalidArgument("Malformed cursor was used.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(raw));
  } catch {
    throw invalidArgument("Malformed cursor was used.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidArgument("Malformed cursor was used.");
  }
  const record = parsed as Record<string, unknown>;
  const read = record.r;
  const key = record.k;
  const userId = record.u;
  if (typeof read !== "number" || !Number.isInteger(read) || read < 0 || read > 2) {
    throw invalidArgument("Malformed cursor was used.");
  }
  if (typeof key !== "string" || typeof userId !== "string") {
    throw invalidArgument("Malformed cursor was used.");
  }
  return { read, key, userId };
}
