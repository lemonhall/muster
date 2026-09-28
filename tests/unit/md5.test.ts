import { describe, expect, it } from "vitest";

import { md5, md5Hex } from "../../src/domain/storage/md5";

/**
 * MD5 的正确性证据。
 *
 * 我们自己实现 MD5 的原因写在 `src/domain/storage/md5.ts` 顶部：workerd 没有 MD5，
 * 而存储对象的 `version` 是上游契约的一部分（`hex(md5(value))`）。既然是自己写的，
 * 就不能只用"自己算两遍一样"来证明——期望值必须来自**参考实现**。
 *
 * 证据分三层：
 *   1. RFC 1321 附录 A.5 的 7 个官方测试向量（覆盖空串、单块、多块）；
 *   2. 分块/填充边界（55/56/57/63/64/65/119/120/127/128/129 字节）——
 *      MD5 的坑几乎全在"0x80 补位 + 长度小端写在末尾 8 字节"这一段；
 *   3. UTF-8 非 ASCII 输入（长度按**字节**算，不是按 JS 字符算）。
 *
 * 第 2、3 层的期望值由本机 Node（OpenSSL 实现）算出后写死，因此这是**跨实现比对**。
 */

/** RFC 1321 附录 A.5 的全部测试套件。 */
const RFC1321_VECTORS: ReadonlyArray<readonly [string, string]> = [
  ["", "d41d8cd98f00b204e9800998ecf8427e"],
  ["a", "0cc175b9c0f1b6a831c399e269772661"],
  ["abc", "900150983cd24fb0d6963f7d28e17f72"],
  ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
  ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
  [
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    "d174ab98d277d9f5a5611c2c9f419d9f",
  ],
  [
    "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
    "57edf4a22be3c955ac49da2e2107b67a",
  ],
];

/** 边界向量：期望值来自本机 Node 的 `crypto.createHash("md5")`。 */
const PADDING_VECTORS: ReadonlyArray<readonly [number, string]> = [
  [55, "ef1772b6dff9a122358552954ad0df65"],
  [56, "3b0c8ac703f828b04c6c197006d17218"],
  [57, "652b906d60af96844ebd21b674f35e93"],
  [63, "b06521f39153d618550606be297466d5"],
  [64, "014842d480b571495a4a0363793f7367"],
  [65, "c743a45e0d2e6a95cb859adae0248435"],
  [119, "8a7bd0732ed6a28ce75f6dabc90e1613"],
  [120, "5f61c0ccad4cac44c75ff505e1f1e537"],
  [127, "020406e1d05cdc2aa287641f7ae2cc39"],
  [128, "e510683b3f5ffe4093d021808bc6ff70"],
  [129, "b325dc1c6f5e7a2b7cf465b9feab7948"],
  [1000, "cabe45dcc9ae5b66ba86600cca6b8ba8"],
];

/** UTF-8 向量：同样是参考实现的输出，用来钉住"长度按字节算"这条。 */
const UTF8_VECTORS: ReadonlyArray<readonly [string, string]> = [
  ["你好，世界", "dbefd3ada018615b35588a01e216ae6e"],
  [
    "存储对象的版本号就是值的 MD5 —— 这段中文用于跨越 64 字节分块边界。",
    "12aaa95ac963001986c622bb1f10ee11",
  ],
];

describe("存储: MD5 (RFC 1321)", () => {
  it("test_rfc1321_appendix_a5_vectors_match", () => {
    for (const [input, expected] of RFC1321_VECTORS) {
      expect(md5Hex(input), `md5(${JSON.stringify(input)})`).toBe(expected);
    }
  });

  it("test_padding_and_block_boundaries_match_reference_implementation", () => {
    for (const [length, expected] of PADDING_VECTORS) {
      expect(md5Hex("a".repeat(length)), `md5("a" x ${length})`).toBe(expected);
    }
  });

  it("test_utf8_input_is_hashed_by_bytes_not_code_units", () => {
    for (const [input, expected] of UTF8_VECTORS) {
      expect(md5Hex(input)).toBe(expected);
    }
    // 长度必须按 UTF-8 字节算：`"你好"` 是 2 个 JS 字符、6 个字节。
    expect(new TextEncoder().encode("你好").length).toBe(6);
    expect(md5Hex("你好")).toBe(md5Hex(new TextEncoder().encode("你好")));
  });

  it("test_digest_shape_is_16_bytes_little_endian_words", () => {
    const digest = md5("abc");
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest.length).toBe(16);
    expect([...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(
      "900150983cd24fb0d6963f7d28e17f72",
    );
  });

  it("test_hex_output_is_lowercase_fixed_width", () => {
    // 存储的 `version` 形状：32 个小写十六进制字符（含前导 0 也不能省）。
    expect(md5Hex("")).toHaveLength(32);
    expect(md5Hex("")).toMatch(/^[0-9a-f]{32}$/u);
    expect(md5Hex("a").startsWith("0cc175b9")).toBe(true);
  });
});
