/**
 * 限流的接入层：读阈值、过桶、把拒绝折成上游形状的 429。
 *
 * 判定本身在 `src/durable/rate-limiter.ts` 的 DO 里（每租户一个实例）。这一层只做三件事：
 *
 *   1. **阈值从绑定读**：`RATE_LIMIT_PER_WINDOW` / `RATE_LIMIT_WINDOW_MS`。
 *      **不配 = 关闭**：上游没有这个中间件，默认开着等于给迁移过来的人一个看不见的
 *      行为变化；运营者要限流就显式拧这两个旋钮（ECN-0014 偏差 4）。
 *   2. **主体**：用户路由用 user id，server key 路由用租户 id——桶的粒度是"谁在刷屏"。
 *   3. **失败开放**：限流器自己炸了不能让整局游戏跟着下线，记一条错误日志然后放行。
 *      这是刻意的取舍：可观测面（`request_log` 与 console 错误）足以暴露问题。
 *
 * 拒绝的形状是 `google.rpc.Status`：`code: 8`（ResourceExhausted）→ HTTP 429，
 * 外加 `retry-after` 头，客户端据此退避而不是盲目重试。
 *
 * 契约源（机器可读）：
 * 契约源: 无（上游没有等价中间件；见 ECN-0014 偏差 4）
 *
 * REQ-0001-023
 */

import type { Bindings } from "../env";
import type { RateLimitDecision } from "../durable/rate-limiter";
import { Code, statusResponse } from "./grpc";

export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

/** 读一个"必须是正整数"的绑定；缺省或非法都返回兜底值。 */
function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export interface RateLimitConfig {
  /** 0 = 关闭。 */
  readonly limit: number;
  readonly windowMs: number;
}

export function rateLimitConfig(env: Bindings): RateLimitConfig {
  return {
    limit: positiveInt(env.RATE_LIMIT_PER_WINDOW, 0),
    windowMs: positiveInt(env.RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS),
  };
}

export function rateLimitMessage(retryAfterSec: number): string {
  return `Rate limit exceeded. Retry after ${retryAfterSec}s.`;
}

/** 429 + `google.rpc.Status` 体 + `retry-after`。 */
export function rateLimitedResponse(decision: RateLimitDecision): Response {
  const response = statusResponse(Code.ResourceExhausted, rateLimitMessage(decision.retryAfterSec));
  response.headers.set("retry-after", String(decision.retryAfterSec));
  return response;
}

/**
 * 问一次限流 DO。未配置阈值 → `null`（调用方直接放行，连 DO 都不碰）。
 */
export async function checkRateLimit(
  env: Bindings,
  tenantId: string,
  subject: string,
): Promise<RateLimitDecision | null> {
  const config = rateLimitConfig(env);
  if (config.limit === 0) return null;

  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(tenantId));
  const response = await stub.fetch("https://rate-limiter.internal/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject, limit: config.limit, windowMs: config.windowMs }),
  });
  return (await response.json()) as RateLimitDecision;
}

/**
 * 处理器外面包一层限流。限流器不可用时**放行**（fail open），只记日志。
 */
export async function serveWithRateLimit(
  env: Bindings,
  tenantId: string,
  subject: string,
  serve: () => Response | Promise<Response>,
): Promise<Response> {
  try {
    const decision = await checkRateLimit(env, tenantId, subject);
    if (decision !== null && decision.limited) return rateLimitedResponse(decision);
  } catch (error) {
    console.error("rate limiter unavailable; serving the request anyway", error);
  }
  return await serve();
}
