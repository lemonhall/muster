import { describe, expect, it } from "vitest";

import { bit32 } from "../../../src/runtime/bit32";

/**
 * `bit32` 的契约测试。
 *
 * 上游把 Shopify 的 `bitwise.lua` 整段当模块跑（`server/runtime_test.go::TestRuntimeBit32`），
 * 这里把那份断言逐个搬到 JS 语义上——包括"空参数是全一""负移位量反向"
 * "移位量绝对值 ≥ 32 清零""越界数按 mod 2^32 折回""extract/replace 越界抛错"。
 *
 * 溯源: server/runtime_test.go::TestRuntimeBit32
 */

describe("M8 bit32: 基础位运算", () => {
  it("test_band_bor_bxor_with_no_arguments", () => {
    expect(bit32.band()).toBe(bit32.bnot(0));
    expect(bit32.btest()).toBe(true);
    expect(bit32.bor()).toBe(0);
    expect(bit32.bxor()).toBe(0);
  });

  it("test_band_of_one_and_two_is_zero", () => {
    expect(bit32.band(1, 2)).toBe(0);
    expect(bit32.band(0xffffffff)).toBe(0xffffffff);
  });

  it("test_out_of_range_numbers_wrap_modulo_2_32", () => {
    expect(bit32.band(-1)).toBe(0xffffffff);
    expect(bit32.band(2 ** 33 - 1)).toBe(0xffffffff);
    expect(bit32.band(-(2 ** 33) - 1)).toBe(0xffffffff);
    expect(bit32.band(2 ** 33 + 1)).toBe(1);
    expect(bit32.band(-(2 ** 33) + 1)).toBe(1);
    expect(bit32.band(-(2 ** 40))).toBe(0);
    expect(bit32.band(2 ** 40)).toBe(0);
    expect(bit32.band(-(2 ** 40) - 2)).toBe(0xfffffffe);
    expect(bit32.band(2 ** 40 - 4)).toBe(0xfffffffc);
  });
});

describe("M8 bit32: 旋转与移位", () => {
  it("test_rotations", () => {
    expect(bit32.lrotate(0, -1)).toBe(0);
    expect(bit32.lrotate(0, 7)).toBe(0);
    expect(bit32.lrotate(0x12345678, 4)).toBe(0x23456781);
    expect(bit32.rrotate(0x12345678, -4)).toBe(0x23456781);
    expect(bit32.lrotate(0x12345678, -8)).toBe(0x78123456);
    expect(bit32.rrotate(0x12345678, 8)).toBe(0x78123456);
    expect(bit32.lrotate(0xaaaaaaaa, 2)).toBe(0xaaaaaaaa);
    expect(bit32.lrotate(0xaaaaaaaa, -2)).toBe(0xaaaaaaaa);
    for (let index = -50; index <= 50; index += 1) {
      expect(bit32.lrotate(0x89abcdef, index)).toBe(bit32.lrotate(0x89abcdef, index % 32));
    }
  });

  it("test_shifts", () => {
    expect(bit32.lshift(0x12345678, 4)).toBe(0x23456780);
    expect(bit32.lshift(0x12345678, 8)).toBe(0x34567800);
    expect(bit32.lshift(0x12345678, -4)).toBe(0x01234567);
    expect(bit32.lshift(0x12345678, -8)).toBe(0x00123456);
    expect(bit32.lshift(0x12345678, 32)).toBe(0);
    expect(bit32.lshift(0x12345678, -32)).toBe(0);
    expect(bit32.rshift(0x12345678, 4)).toBe(0x01234567);
    expect(bit32.rshift(0x12345678, 8)).toBe(0x00123456);
    expect(bit32.rshift(0x12345678, 32)).toBe(0);
    expect(bit32.rshift(0x12345678, -32)).toBe(0);
  });

  it("test_arithmetic_shift", () => {
    expect(bit32.arshift(0x12345678, 0)).toBe(0x12345678);
    expect(bit32.arshift(0x12345678, 1)).toBe(0x12345678 / 2);
    expect(bit32.arshift(0x12345678, -1)).toBe(0x12345678 * 2);
    expect(bit32.arshift(-1, 1)).toBe(0xffffffff);
    expect(bit32.arshift(-1, 24)).toBe(0xffffffff);
    expect(bit32.arshift(-1, 32)).toBe(0xffffffff);
    // Lua 的 `%` 是 floor-mod（负数也折回非负），与 JS 的 `%` 不同，所以写死期望值。
    expect(bit32.arshift(-1, -1)).toBe(2 ** 32 - 2);
  });
});

describe("M8 bit32: 特例与代数恒等式", () => {
  const CASES = [0, 1, 2, 3, 10, 0x80000000, 0xaaaaaaaa, 0x55555555, 0xffffffff, 0x7fffffff];

  it("test_each_special_case_follows_the_bitwise_identities", () => {
    for (const value of CASES) {
      expect(bit32.band(value)).toBe(value);
      expect(bit32.band(value, value)).toBe(value);
      expect(bit32.btest(value, value)).toBe(value !== 0);
      expect(bit32.band(value, value, value)).toBe(value);
      expect(bit32.btest(value, value, value)).toBe(value !== 0);
      expect(bit32.band(value, bit32.bnot(value))).toBe(0);
      expect(bit32.bor(value, bit32.bnot(value))).toBe(bit32.bnot(0));
      expect(bit32.bor(value)).toBe(value);
      expect(bit32.bor(value, value, value)).toBe(value);
      expect(bit32.bxor(value)).toBe(value);
      expect(bit32.bxor(value, value)).toBe(0);
      expect(bit32.bxor(value, 0)).toBe(value);
      expect(bit32.bnot(bit32.bnot(value))).toBe(value);
      expect(bit32.bnot(value)).toBe(2 ** 32 - 1 - value);
      expect(bit32.lrotate(value, 32)).toBe(value);
      expect(bit32.rrotate(value, 32)).toBe(value);
      expect(bit32.lshift(bit32.lshift(value, -4), 4)).toBe(bit32.band(value, bit32.bnot(0xf)));
      expect(bit32.rshift(bit32.rshift(value, 4), -4)).toBe(bit32.band(value, bit32.bnot(0xf)));
      for (let index = -40; index <= 40; index += 1) {
        expect(bit32.lshift(value, index)).toBe(Math.floor((value * 2 ** index) % 2 ** 32));
      }
    }
  });
});

describe("M8 bit32: 参数校验（上游用 pcall 断言必须失败）", () => {
  it("test_bad_argument_types_throw", () => {
    expect(() => bit32.band({})).toThrow();
    expect(() => bit32.bnot("a")).toThrow();
    // 上游这里是 `pcall(bit32.lshift, 45, print)`：**函数**当位移量必须被拒。
    const notANumber = (() => 0) as unknown;
    expect(() => (bit32.lshift as (v: unknown, s: unknown) => number)(45, notANumber)).toThrow();
    expect(() => (bit32.rshift as (v: unknown, s: unknown) => number)(45, notANumber)).toThrow();
  });

  it("test_missing_shift_argument_throws", () => {
    expect(() => (bit32.lshift as (value: unknown) => number)(45)).toThrow();
  });
});

describe("M8 bit32: extract / replace", () => {
  it("test_extract_fields", () => {
    expect(bit32.extract(0x12345678, 0, 4)).toBe(8);
    expect(bit32.extract(0x12345678, 4, 4)).toBe(7);
    expect(bit32.extract(0xa0001111, 28, 4)).toBe(0xa);
    expect(bit32.extract(0xa0001111, 31, 1)).toBe(1);
    expect(bit32.extract(0x50000111, 31, 1)).toBe(0);
    expect(bit32.extract(0xf2345679, 0, 32)).toBe(0xf2345679);
  });

  it("test_extract_out_of_range_fields_throw", () => {
    expect(() => bit32.extract(0, -1)).toThrow();
    expect(() => bit32.extract(0, 32)).toThrow();
    expect(() => bit32.extract(0, 0, 33)).toThrow();
    expect(() => bit32.extract(0, 31, 2)).toThrow();
  });

  it("test_replace_fields", () => {
    expect(bit32.replace(0x12345678, 5, 28, 4)).toBe(0x52345678);
    expect(bit32.replace(0x12345678, 0x87654321, 0, 32)).toBe(0x87654321);
    expect(bit32.replace(0, 1, 2)).toBe(2 ** 2);
    expect(bit32.replace(0, -1, 4)).toBe(2 ** 4);
    expect(bit32.replace(-1, 0, 31)).toBe(2 ** 31 - 1);
    expect(bit32.replace(-1, 0, 1, 2)).toBe(2 ** 32 - 7);
  });
});
