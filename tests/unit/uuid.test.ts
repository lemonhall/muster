import { describe, expect, it } from "vitest";

import { NAMESPACE_DNS, uuidV4, uuidV5 } from "../../src/domain/uuid";

/**
 * M7 契约：RFC 4122 的 v5 派生（`match_create` 带 `name` 时的 match id 来源）。
 *
 * 为什么值必须写死而不是"两边都算一遍"：派生算法一旦漂移，客户端**算不出**同一个
 * match id，重连就会开出一场新对局——这个 bug 在只比对"派生函数输出"的测试里
 * 根本看不出来。所以这里钉两枚公开向量：
 *
 * - `python.org`：Python 标准库文档里的 DNS 名字空间向量；
 * - `hello.example.com`：`uuid` npm 包 README 里的向量。
 *
 * 两枚向量都另用一份独立实现（Node 内置 `crypto` 的 SHA-1）复算过，不是抄来的。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_match.go::Pipeline.matchCreate
 *
 * REQ-0001-018
 */

describe("M7 契约: RFC 4122 v5 派生", () => {
  it("test_known_dns_vectors_match_the_published_values", async () => {
    expect(await uuidV5(NAMESPACE_DNS, "python.org")).toBe(
      "886313e1-3b8a-5372-9b90-0c9aee199e5d",
    );
    expect(await uuidV5(NAMESPACE_DNS, "hello.example.com")).toBe(
      "fdda765f-fc57-5604-a269-52a7df8164ec",
    );
  });

  it("test_the_version_and_variant_bits_are_written_in", async () => {
    const derived = await uuidV5(NAMESPACE_DNS, "muster-room");
    // 第 3 组的首位是版本号 5，第 4 组的首位是变体位 8/9/a/b。
    expect(derived[14]).toBe("5");
    expect("89ab").toContain(derived[19] as string);
  });

  it("test_the_same_name_always_derives_the_same_id", async () => {
    // 重复派生（含大小写不同的**名字**）是客户端重连回同一场对局的全部依据。
    expect(await uuidV5(NAMESPACE_DNS, "room-1")).toBe(await uuidV5(NAMESPACE_DNS, "room-1"));
    expect(await uuidV5(NAMESPACE_DNS, "room-1")).not.toBe(
      await uuidV5(NAMESPACE_DNS, "Room-1"),
    );
  });

  it("test_v4_is_a_lowercase_random_uuid", () => {
    const first = uuidV4();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(uuidV4()).not.toBe(first);
  });
});
