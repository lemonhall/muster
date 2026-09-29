import { describe, expect, it } from "vitest";

import {
  rateLimitStep,
  type RateLimitBucket,
  type RateLimitDecision,
} from "../../../src/durable/rate-limiter";
import { DEFAULT_RATE_LIMIT_WINDOW_MS, rateLimitConfig } from "../../../src/http/rate-limit";
import type { Bindings } from "../../../src/env";

/**
 * M9 限流：窗口语义的**纯函数**那一半。
 *
 * 集成测试证明"HTTP 链路上真的 429"，这里证明桶的算法本身：窗口起止怎么算、
 * 边界那一条算不算超限、被拒的请求会不会把窗口往后推（会就变成永久封禁）、
 * 以及 `retry-after` 的上取整。都是不碰 DO、不碰网络的纯断言。
 *
 * 契约源（机器可读）：
 * 契约源: 无（上游没有等价中间件；见 ECN-0014 偏差 4）
 *
 * REQ-0001-023
 */

const LIMIT = 2;
const WINDOW_MS = 1_000;

function step(bucket: RateLimitBucket | undefined, now: number): {
  readonly bucket: RateLimitBucket;
  readonly decision: RateLimitDecision;
} {
  return rateLimitStep(bucket, LIMIT, WINDOW_MS, now);
}

describe("M9 限流窗口: 边界", () => {
  it("test_a_fresh_bucket_opens_a_window_and_counts_one", () => {
    const first = step(undefined, 5_000);
    expect(first.bucket).toEqual({ windowStart: 5_000, count: 1 });
    expect(first.decision).toEqual({ limited: false, limit: LIMIT, remaining: 1, retryAfterSec: 0 });
  });

  it("test_the_request_that_reaches_the_limit_is_still_allowed", () => {
    // 上限是"允许 N 条"，不是"允许 N-1 条"：第 N 条仍然是 200，remaining 归零。
    const second = step({ windowStart: 5_000, count: 1 }, 5_100);
    expect(second.bucket).toEqual({ windowStart: 5_000, count: 2 });
    expect(second.decision.limited).toBe(false);
    expect(second.decision.remaining).toBe(0);
  });

  it("test_the_request_past_the_limit_is_rejected_with_a_retry_hint", () => {
    const over = step({ windowStart: 5_000, count: LIMIT }, 5_300);
    expect(over.decision.limited).toBe(true);
    expect(over.decision.remaining).toBe(0);
    // 距离窗口结束还有 700ms → 保守地按 1 秒告诉客户端。
    expect(over.decision.retryAfterSec).toBe(1);
  });

  it("test_a_rejected_request_does_not_push_the_window_forward", () => {
    const exhausted: RateLimitBucket = { windowStart: 5_000, count: LIMIT };
    const first = step(exhausted, 5_300);
    const later = step(first.bucket, 5_900);
    // 桶没被改动，窗口起点还是 5000：否则一直刷就能把所有人永久锁在 429 上。
    expect(first.bucket).toEqual(exhausted);
    expect(later.bucket).toEqual(exhausted);
    expect(later.decision.retryAfterSec).toBe(1);
  });

  it("test_the_window_slides_once_it_expires", () => {
    const exhausted: RateLimitBucket = { windowStart: 5_000, count: LIMIT };
    // 窗口结束的那一刻（>=开始+窗口）就开新窗口，不是"必须大于"。
    const after = step(exhausted, 5_000 + WINDOW_MS);
    expect(after.bucket).toEqual({ windowStart: 6_000, count: 1 });
    expect(after.decision.limited).toBe(false);
    expect(after.decision.remaining).toBe(LIMIT - 1);
  });
});

describe("M9 限流阈值: 绑定解析", () => {
  function envWith(entries: Record<string, string | undefined>): Bindings {
    return entries as unknown as Bindings;
  }

  it("test_an_unconfigured_environment_is_disabled", () => {
    expect(rateLimitConfig(envWith({}))).toEqual({ limit: 0, windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS });
  });

  it("test_configured_values_are_used_verbatim", () => {
    expect(rateLimitConfig(envWith({ RATE_LIMIT_PER_WINDOW: "120", RATE_LIMIT_WINDOW_MS: "500" })))
      .toEqual({ limit: 120, windowMs: 500 });
  });

  it("test_a_broken_value_falls_back_instead_of_guessing", () => {
    const broken = envWith({ RATE_LIMIT_PER_WINDOW: "abc", RATE_LIMIT_WINDOW_MS: "-3" });
    // 阈值非法时**关闭**限流，而不是猜一个数：猜出来的限制比不限制更难排查。
    expect(rateLimitConfig(broken)).toEqual({ limit: 0, windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS });
    expect(rateLimitConfig(envWith({ RATE_LIMIT_PER_WINDOW: "5", RATE_LIMIT_WINDOW_MS: "0" })))
      .toEqual({ limit: 5, windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS });
  });
});
