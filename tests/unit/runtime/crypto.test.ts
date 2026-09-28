import { describe, expect, it } from "vitest";

import {
  aes128Decrypt,
  aes128Encrypt,
  base16Decode,
  base16Encode,
  base64Decode,
  base64Encode,
  base64UrlDecode,
  base64UrlEncode,
  bcryptCompare,
  bcryptHash,
  md5Hash,
  sha256Hash,
  uuidv4,
} from "../../../src/runtime/crypto";

/**
 * `nk` 工具函数面的契约测试。
 *
 * 逐条搬运 `server/runtime_test.go` 里那一组：MD5/SHA-256 的**字面期望值**、
 * base64 / base64url / base16 往返、AES-128 往返回原串（去掉补齐的空格）、
 * bcrypt 的哈希与校验、UUID 形状。
 *
 * 溯源: server/runtime_test.go::TestRuntimeMD5Hash,TestRuntimeSHA256Hash,TestRuntimeBase64,TestRuntimeBase16,TestRuntimeAes128,TestRuntimeBcryptHash,TestRuntimeBcryptCompare
 */

const PAYLOAD = '{"key":"value"}';
const AES_KEY = "goldenbridge_key"; // 上游用的就是这把 16 字节的 key

describe("M8 nk 工具: 摘要", () => {
  it("test_md5_of_test", () => {
    expect(md5Hash("test")).toBe("098f6bcd4621d373cade4e832627b4f6");
  });

  it("test_sha256_of_test", async () => {
    expect(await sha256Hash("test")).toBe(
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    );
  });
});

describe("M8 nk 工具: 编解码往返", () => {
  it("test_base64_round_trip", () => {
    expect(base64Decode(base64Encode(PAYLOAD))).toBe(PAYLOAD);
  });

  it("test_base64_url_round_trip", () => {
    expect(base64UrlDecode(base64UrlEncode(PAYLOAD))).toBe(PAYLOAD);
  });

  it("test_base16_round_trip", () => {
    expect(base16Decode(base16Encode(PAYLOAD))).toBe(PAYLOAD);
  });

  it("test_base64_without_padding_uses_the_raw_alphabet", () => {
    expect(base64Encode("hello", false)).toBe("aGVsbG8");
    expect(base64UrlEncode("hello", false)).toBe("aGVsbG8");
    expect(base64Decode("aGVsbG8")).toBe("hello");
  });

  it("test_empty_string_is_rejected", () => {
    expect(() => base64Encode("")).toThrow();
    expect(() => base64Decode("")).toThrow();
    expect(() => base16Encode("")).toThrow();
  });

  it("test_bad_base64_is_rejected", () => {
    expect(() => base64Decode("!!!!")).toThrow();
    expect(() => base16Decode("xyz")).toThrow();
  });
});

describe("M8 nk 工具: AES-128", () => {
  it("test_aes128_round_trip_trims_back_to_the_payload", () => {
    const cipher = aes128Encrypt(PAYLOAD, AES_KEY);
    expect(aes128Decrypt(cipher, AES_KEY).trim()).toBe(PAYLOAD);
  });

  it("test_aes128_keeps_the_padding_spaces", () => {
    // 上游不解补齐，返回的串比原文长（补到 4 的倍数）。15 字节 → 16 字节。
    const cipher = aes128Encrypt(PAYLOAD, AES_KEY);
    expect(PAYLOAD.length).toBe(15);
    expect(aes128Decrypt(cipher, AES_KEY).length).toBe(16);
  });

  it("test_payload_length_multiple_of_four_is_untouched", () => {
    const exact = "abcd";
    expect(aes128Decrypt(aes128Encrypt(exact, AES_KEY), AES_KEY)).toBe(exact);
  });

  it("test_aes128_key_length_is_checked_in_bytes", () => {
    expect(() => aes128Encrypt(PAYLOAD, "short")).toThrow(/expects key 16 bytes long/);
    // 8 个中文字符 = 24 字节 ≠ 16，必须被拒（按字节算，不是按字符算）。
    expect(() => aes128Encrypt(PAYLOAD, "八个中文字符啊啊啊")).toThrow();
  });

  it("test_the_iv_is_random_so_ciphertexts_differ", () => {
    expect(aes128Encrypt(PAYLOAD, AES_KEY)).not.toBe(aes128Encrypt(PAYLOAD, AES_KEY));
  });
});

describe("M8 nk 工具: 口令哈希", () => {
  it("test_hash_then_compare_succeeds", async () => {
    const hash = await bcryptHash(PAYLOAD);
    expect(await bcryptCompare(hash, PAYLOAD)).toBe(true);
  });

  it("test_wrong_password_returns_false", async () => {
    const hash = await bcryptHash("something_to_encrypt");
    expect(await bcryptCompare(hash, "not_the_password")).toBe(false);
  });

  it("test_hash_string_is_not_the_plaintext", async () => {
    const hash = await bcryptHash("something_to_encrypt");
    expect(hash).not.toBe("something_to_encrypt");
    expect(hash.startsWith("pbkdf2-sha256$")).toBe(true);
  });

  it("test_malformed_hash_returns_false_instead_of_throwing", async () => {
    expect(await bcryptCompare("not-a-hash", "x")).toBe(false);
    expect(await bcryptCompare("pbkdf2-sha256$0$AA$AA", "x")).toBe(false);
    expect(await bcryptCompare("bcrypt$10$AA$AA", "x")).toBe(false);
  });
});

describe("M8 nk 工具: UUID", () => {
  it("test_uuid_v4_shape", () => {
    expect(uuidv4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("test_uuid_v4_is_random", () => {
    expect(uuidv4()).not.toBe(uuidv4());
  });
});
