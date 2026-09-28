/**
 * 索引列表游标。
 *
 * 上游把 `indexListCursor{Query, Offset, Limit, Order}` 用 gob 编码后 base64url 输出。
 * 我们换成 base64url(JSON)——游标对客户端是**不透明**的（只有服务端能解），可观测语义
 * 只有两条：分页能往前走；把上一页的游标配上不同的 query/limit/order 会被拒。
 * 这两条在 JSON 编码下逐条成立，论证见 `docs/ecn/ECN-0004-storage-cursor-encoding.md`。
 *
 * 解不开、或四元组与本次请求不符 → `invalid`（上游 `ErrBadInput`）的错误消息逐字照抄：
 * `invalid cursor: query mismatch` / `limit mismatch` / `order mismatch`。
 */

import { Code } from "../../../http/grpc";
import { ApiError } from "../../../http/errors";
import type { IndexCursor } from "./types";

function badInput(message: string): ApiError {
  return new ApiError(Code.InvalidArgument, message);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  try {
    return atob(withPadding);
  } catch {
    return null;
  }
}

export function encodeIndexCursor(cursor: IndexCursor): string {
  const payload = JSON.stringify({
    q: cursor.query,
    o: cursor.offset,
    l: cursor.limit,
    r: cursor.order,
  });
  return toBase64Url(new TextEncoder().encode(payload));
}

/** 解不开就是 `invalid cursor: <原因>`；四元组不符由调用方比对（见 `assertCursorMatches`）。 */
export function decodeIndexCursor(raw: string): IndexCursor {
  const decoded = fromBase64Url(raw);
  if (decoded === null) throw badInput("invalid cursor: illegal base64 data");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw badInput("invalid cursor: malformed payload");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badInput("invalid cursor: malformed payload");
  }
  const record = parsed as Record<string, unknown>;
  const query = record.q;
  const offset = record.o;
  const limit = record.l;
  const order = record.r;
  if (
    typeof query !== "string" ||
    typeof offset !== "number" ||
    typeof limit !== "number" ||
    !Array.isArray(order) ||
    order.some((item) => typeof item !== "string")
  ) {
    throw badInput("invalid cursor: malformed payload");
  }
  return { query, offset, limit, order: order as string[] };
}

/** 三个不匹配各有各的消息，顺序也照上游：query → limit → order。 */
export function assertCursorMatches(cursor: IndexCursor, expected: IndexCursor): void {
  if (cursor.query !== expected.query) throw badInput("invalid cursor: query mismatch");
  if (cursor.limit !== expected.limit) throw badInput("invalid cursor: limit mismatch");
  if (cursor.order.length !== expected.order.length) {
    throw badInput("invalid cursor: order mismatch");
  }
  for (let index = 0; index < cursor.order.length; index += 1) {
    if (cursor.order[index] !== expected.order[index]) throw badInput("invalid cursor: order mismatch");
  }
}
