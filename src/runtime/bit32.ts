/**
 * Lua 5.2 `bit32` 库的等价实现（上游把整段 Lua 测试套件作为模块直接跑）。
 *
 * 上游没有 JS 版的 `bit32`——它是 Lua 运行时的库。muster 只支持 JS 模块，
 * 但覆盖矩阵里那 12 个用例族（`TestRuntimeBit32`）钉的是**可观测行为**：32 位无符号
 * 语义、越界数按 `mod 2^32` 折回、移位量为负时反向、`extract` / `replace` 的越界
 * 报错。所以这里按同样的语义实现一遍，让模块作者拿得到同一个工具箱。
 *
 * 逐条对齐的语义（全部来自 `TestRuntimeBit32` 的断言）：
 *
 * | 输入 | 期望 | 为什么 |
 * |---|---|---|
 * | `band()` | `0xffffffff` | 空参数是"全一"（Lua 的实现细节，反直觉但必须照抄） |
 * | `bor()` / `bxor()` | `0` | 空参数是 0 |
 * | `btest()` | `true` | `btest` 就是 `band(...) ~= 0` |
 * | `band(2^33 + 1)` | `1` | 先取整再 `mod 2^32` |
 * | `band(-2^33 - 1)` | `0xffffffff` | 负数同样折回无符号 |
 * | `lshift(x, -4)` | 逻辑右移 4 | 负移位量反向 |
 * | `lshift(x, 32)` | `0` | 移位量绝对值 ≥ 32 即清零 |
 * | `arshift(-1, -1)` | `0xfffffffe` | 负移位量走左移，不做符号位展开 |
 * | `arshift(-1, 32)` | `0xffffffff` | 算术右移 ≥ 32 时按符号位铺满 |
 * | `extract(n, 32)` | 抛错 | 位域必须落在 `0..31` 内，且 `field + width <= 32` |
 *
 * **非数字参数一律抛 `TypeError`**（Lua 那边是 `luaL_checkinteger` panic，
 * 测试用 `pcall` 断言"必须失败"）。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime_test.go::TestRuntimeBit32
 *
 * REQ-0001-020
 */

const BITS = 32;
const MODULO = 4294967296;
const ALL_ONES = MODULO - 1;

/** Lua 的 `luaL_checkinteger`：非数字直接抛；数值先取整再折回 32 位无符号。 */
function toUint32(value: unknown): number {
  if (typeof value !== "number") throw new TypeError("number expected");
  if (!Number.isFinite(value)) throw new TypeError("number has no integer representation");
  const truncated = Math.trunc(value);
  return ((truncated % MODULO) + MODULO) % MODULO;
}

/** 移位量：必须是整数（同样拒非数字），可为负。 */
function toShift(value: unknown): number {
  if (typeof value !== "number") throw new TypeError("number expected");
  if (!Number.isFinite(value)) throw new TypeError("number has no integer representation");
  return Math.trunc(value);
}

function shiftLeft(value: number, count: number): number {
  if (count >= BITS) return 0;
  if (count <= -BITS) return 0;
  if (count < 0) return value >>> -count;
  return (value << count) >>> 0;
}

function shiftRight(value: number, count: number): number {
  if (count >= BITS) return 0;
  if (count <= -BITS) return 0;
  if (count < 0) return (value << -count) >>> 0;
  return value >>> count;
}

function shiftArithmetic(value: number, count: number): number {
  if (count < 0) return shiftLeft(value, -count);
  const negative = (value & 0x80000000) !== 0;
  if (count >= BITS) return negative ? ALL_ONES : 0;
  const shifted = (value >> count) >>> 0;
  return shifted;
}

function maskOf(width: number): number {
  return width === BITS ? ALL_ONES : (1 << width) - 1;
}

/** `extract` / `replace` 共用的位域校验（Lua 的两条 `luaL_argcheck`）。 */
function checkField(field: unknown, width: unknown): { field: number; width: number } {
  const f = toUint32(field);
  const w = width === undefined ? 1 : toUint32(width);
  if (w < 1) throw new RangeError("field width must be positive");
  if (f > BITS - 1) throw new RangeError("field cannot start at this position");
  if (f + w > BITS) throw new RangeError("field cannot extend past the end");
  return { field: f, width: w };
}

export const bit32 = {
  band(...values: readonly unknown[]): number {
    if (values.length === 0) return ALL_ONES;
    return values.reduce<number>((acc, value, index) => {
      const current = toUint32(value);
      return index === 0 ? current : acc & current;
    }, 0) >>> 0;
  },

  bor(...values: readonly unknown[]): number {
    return values.reduce<number>((acc, value) => acc | toUint32(value), 0) >>> 0;
  },

  bxor(...values: readonly unknown[]): number {
    return values.reduce<number>((acc, value) => acc ^ toUint32(value), 0) >>> 0;
  },

  bnot(value: unknown): number {
    return ~toUint32(value) >>> 0;
  },

  btest(...values: readonly unknown[]): boolean {
    return bit32.band(...values) !== 0;
  },

  lrotate(value: unknown, count: unknown): number {
    const v = toUint32(value);
    const n = ((toShift(count) % BITS) + BITS) % BITS;
    if (n === 0) return v;
    return ((v << n) | (v >>> (BITS - n))) >>> 0;
  },

  rrotate(value: unknown, count: unknown): number {
    const v = toUint32(value);
    const n = ((toShift(count) % BITS) + BITS) % BITS;
    if (n === 0) return v;
    return ((v >>> n) | (v << (BITS - n))) >>> 0;
  },

  lshift(value: unknown, count: unknown): number {
    return shiftLeft(toUint32(value), toShift(count));
  },

  rshift(value: unknown, count: unknown): number {
    return shiftRight(toUint32(value), toShift(count));
  },

  arshift(value: unknown, count: unknown): number {
    return shiftArithmetic(toUint32(value), toShift(count));
  },

  extract(value: unknown, field: unknown, width?: unknown): number {
    const { field: f, width: w } = checkField(field, width);
    return ((toUint32(value) >>> f) & maskOf(w)) >>> 0;
  },

  replace(value: unknown, replacement: unknown, field: unknown, width?: unknown): number {
    const { field: f, width: w } = checkField(field, width);
    const mask = (maskOf(w) << f) >>> 0;
    const n = toUint32(value);
    const r = toUint32(replacement);
    return (((n & ~mask) | ((r & maskOf(w)) << f)) >>> 0) >>> 0;
  },
};

export type Bit32 = typeof bit32;
