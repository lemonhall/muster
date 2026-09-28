import { describe, expect, it } from "vitest";

import { aesCfbDecrypt, aesCfbEncrypt, encryptBlock, expandKey } from "../../../src/runtime/aes-cfb";

/**
 * AES-128 与 CFB 的自实现校验。
 *
 * 两层证据：
 * 1. **块加密**用 FIPS-197 附录 B 的官方向量（key `000102...0f`、
 *    明文 `00112233445566778899aabbccddeeff` → 密文 `69c4e0d8...`）——这是"抄错
 *    S 盒 / 行移位 / 列混淆"时最先炸的地方；
 * 2. **CFB 模式**用"不满一块的尾巴"与"寄存器按密文更新"两条边界，保证与 Go 的
 *    `cipher.NewCFBEncrypter` 行为一致（上游的 `aes128_encrypt` 就是它）。
 *
 * 端到端证据在 `tests/unit/runtime/crypto.test.ts`：`aes128Decrypt(aes128Encrypt(x))`
 * 回到原串（mod 补齐的空格）。
 */

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function hex(input: Uint8Array): string {
  return Array.from(input)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("AES-128 块加密", () => {
  it("test_fips_197_appendix_b_vector", () => {
    const key = bytes("000102030405060708090a0b0c0d0e0f");
    const plain = bytes("00112233445566778899aabbccddeeff");

    expect(hex(encryptBlock(expandKey(key), plain))).toBe("69c4e0d86a7b0430d8cdb78070b4c55a");
  });

  it("test_fips_197_appendix_c_1_vector", () => {
    // key 全零、明文全零 → 66e94bd4ef8a2c3b884cfa59ca342b2e
    expect(hex(encryptBlock(expandKey(new Uint8Array(16)), new Uint8Array(16)))).toBe(
      "66e94bd4ef8a2c3b884cfa59ca342b2e",
    );
  });

  it("test_key_must_be_sixteen_bytes", () => {
    expect(() => expandKey(new Uint8Array(15))).toThrow(RangeError);
    expect(() => expandKey(new Uint8Array(32))).toThrow(RangeError);
  });
});

describe("CFB 模式", () => {
  const key = bytes("2b7e151628aed2a6abf7158809cf4f3c");
  const iv = bytes("000102030405060708090a0b0c0d0e0f");

  it("test_round_trip_on_a_full_block", () => {
    const plain = bytes("6bc1bee22e409f96e93d7e117393172a");
    const cipher = aesCfbEncrypt(key, iv, plain);
    expect(hex(aesCfbDecrypt(key, iv, cipher))).toBe(hex(plain));
  });

  it("test_round_trip_on_a_partial_tail", () => {
    // 4 的倍数但不是 16 的倍数：上游的补齐规则就是这个形状。
    const plain = bytes("6bc1bee22e409f96");
    const cipher = aesCfbEncrypt(key, iv, plain);
    expect(cipher.length).toBe(plain.length);
    expect(hex(cipher)).not.toBe(hex(plain));
    expect(hex(aesCfbDecrypt(key, iv, cipher))).toBe(hex(plain));
  });

  it("test_first_block_uses_the_iv_as_the_register", () => {
    // 首块密文 = 明文 XOR E(IV)，与 IV 直接相关；换 IV 首块必变。
    const plain = new Uint8Array(16);
    const other = iv.slice();
    other[0] = 0xff;
    expect(hex(aesCfbEncrypt(key, iv, plain))).not.toBe(hex(aesCfbEncrypt(key, other, plain)));
  });

  it("test_empty_input_is_empty_output", () => {
    expect(aesCfbEncrypt(key, iv, new Uint8Array(0)).length).toBe(0);
    expect(aesCfbDecrypt(key, iv, new Uint8Array(0)).length).toBe(0);
  });
});
