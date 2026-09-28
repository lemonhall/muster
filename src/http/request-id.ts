/**
 * 请求 ID 关联：响应头 `x-request-id` 与请求日志行上的同一个 id。
 *
 * 上游是常驻进程 + 结构化日志打到 stdout，运维靠"日志里那一列 trace id"把一次请求
 * 串起来（`LoggerWithTraceId`）。Worker 上没有可读的 stdout，所以这里把**日志行落到
 * `request_log` 表**（见 `migrations/0007_console.sql`）：它既是对外的可观测面，也是
 * "响应头与日志同 id"这条验收的落点。登记的偏差见 ECN-0014 偏差 2。
 *
 * 客户端给了 `x-request-id` 就沿用（调用链跨多个服务时仍然只是一条），没给就自造一个
 * UUID。沿用前会做一次形状过滤：这个值要进响应头也要落库，不能让任意字节流进来。
 *
 * 契约源（机器可读）：
 * 契约源: server/console.go::LoggerWithTraceId
 *
 * REQ-0001-023
 */

import type { Bindings } from "../env";

export const REQUEST_ID_HEADER = "x-request-id";

/** 沿用客户端 id 的上限；超过就自造（响应头塞一个几 KB 的值只会害了下游）。 */
const MAX_REQUEST_ID_LENGTH = 128;

/** 可打印、无空白、无控制字符。上游的 trace id 是 UUID，这个集合是它的超集。 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._~:+/=-]+$/u;

/** 客户端给的 id（合法时沿用）或一个自造的 UUID。 */
export function requestIdOf(request: Request): string {
  const raw = (request.headers.get(REQUEST_ID_HEADER) ?? "").trim();
  if (raw !== "" && raw.length <= MAX_REQUEST_ID_LENGTH && SAFE_REQUEST_ID.test(raw)) return raw;
  return crypto.randomUUID();
}

/**
 * 把 id 写进响应头。所有响应（成功、失败、404/501）都要带。
 *
 * WebSocket 的 101 升级响应是个例外：它的头是**不可变**的，改不了就得换一个 Response
 * 并把 `webSocket` 原样带过去（Workers 允许 `status: 101` + `webSocket` 这种构造，
 * 这是它给升级响应开的唯一一条路）。少了这个分支，所有 `/ws` 握手都会 500。
 */
export function withRequestId(response: Response, requestId: string): Response {
  try {
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set(REQUEST_ID_HEADER, requestId);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
      webSocket: response.webSocket ?? null,
    });
  }
}

/**
 * 落一行请求日志。
 *
 * **日志失败不能改变响应**：这里把异常吃掉并打一条控制台错误——"审计写不进去"是运维
 * 要处理的事，不是让这次业务请求跟着失败的理由。租户只在这一层之后才确定（鉴权在
 * 分发层做），所以没有解析出租户的请求（401/404 等）不写日志行。
 */
export async function recordRequest(
  env: Bindings,
  tenantId: string,
  requestId: string,
  request: Request,
  status: number,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO request_log (tenant_id, id, request_id, method, path, status, create_time)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
      .bind(
        tenantId,
        crypto.randomUUID(),
        requestId,
        request.method.toUpperCase(),
        new URL(request.url).pathname,
        status,
        Math.floor(Date.now() / 1000),
      )
      .run();
  } catch (error) {
    console.error("failed to write the request log row", error);
  }
}
