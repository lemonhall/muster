/**
 * 限流 DO：**每租户一个实例**，桶只活在内存里。
 *
 * 为什么是这个载体（ECN-0014 偏差 4）：上游的限流中间件是常驻进程里的内存令牌桶，
 * 本项目的等价物是 Durable Object——它是**唯一**能在无状态 Worker 之间稳定计数的原语
 * （每个 isolate 各存一份计数，等于没限）。实例名是租户 id，所以"A 游戏被打满"
 * 天然不会影响 B 游戏：两个租户的计数在不同的 DO 里。
 *
 * 桶**不落库**：丢了只是"限流窗口重新开始"，而不是数据损坏。这也让这个 DO 不需要
 * 任何迁移与 `blockConcurrencyWhile`。代价是 DO 被回收后计数清零——等价于窗口滑过，
 * 与"窗口自然过期"同一个方向，不会把用户锁死。
 *
 * 计数粒度是 DO 内的 `subject`：用户路由用 user id，server key 路由用租户 id。
 * 于是"客户端刷屏"只打满自己那一个桶。
 *
 * 契约源（机器可读）：
 * 契约源: 无（上游没有等价中间件；见 ECN-0014 偏差 4）
 *
 * REQ-0001-023
 */

import { DurableObject } from "cloudflare:workers";

import type { Bindings } from "../env";

/** 一个固定窗口的计数。时间单位是毫秒的 Unix 时间戳。 */
export interface RateLimitBucket {
  readonly windowStart: number;
  readonly count: number;
}

/** 一次判定的结果。`retryAfterSec` 只在被拒时有意义（对外进 `retry-after` 头）。 */
export interface RateLimitDecision {
  readonly limited: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly retryAfterSec: number;
}

export interface RateLimitCheckInput {
  readonly subject: string;
  readonly limit: number;
  readonly windowMs: number;
}

/** 判定 + 新桶。抽成纯函数是为了让"窗口滑动"这条语义能单测，不必起 DO。 */
export function rateLimitStep(
  bucket: RateLimitBucket | undefined,
  limit: number,
  windowMs: number,
  now: number,
): { readonly bucket: RateLimitBucket; readonly decision: RateLimitDecision } {
  const expired = bucket === undefined || now >= bucket.windowStart + windowMs;
  if (expired) {
    return {
      bucket: { windowStart: now, count: 1 },
      decision: { limited: false, limit, remaining: limit - 1, retryAfterSec: 0 },
    };
  }

  if (bucket.count >= limit) {
    // 被拒的请求**不计入**窗口：否则一个客户端可以用"继续刷"把窗口一直往后推，
    // 从"限流"变成"永久封禁"。
    return {
      bucket,
      decision: {
        limited: true,
        limit,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil((bucket.windowStart + windowMs - now) / 1000)),
      },
    };
  }

  const count = bucket.count + 1;
  return {
    bucket: { windowStart: bucket.windowStart, count },
    decision: { limited: false, limit, remaining: limit - count, retryAfterSec: 0 },
  };
}

export class RateLimiter extends DurableObject<Bindings> {
  readonly #buckets = new Map<string, RateLimitBucket>();

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/check") {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const input = (await request.json()) as RateLimitCheckInput;
    const step = rateLimitStep(
      this.#buckets.get(input.subject),
      input.limit,
      input.windowMs,
      Date.now(),
    );
    this.#buckets.set(input.subject, step.bucket);
    return new Response(JSON.stringify(step.decision), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}
