/**
 * MD5（RFC 1321）——存储对象的 `version` 就是值的 MD5 十六进制。
 *
 * 为什么自己写一个：workerd 的 `crypto.subtle.digest` 只认 SHA-1/SHA-256/384/512，
 * **没有 MD5**。而 `version` 是上游契约的一部分：上游用
 * `hex.EncodeToString(md5.Sum([]byte(value)))` 生成，客户端会把这个字符串原样回传做
 * OCC 校验，测试也会比对它。所以这里不能"换个更现代的摘要"了事——那样形状就变了。
 *
 * 安全性说明：MD5 在这里**不是安全原语**，它只是"值的指纹"，用来做乐观锁与幂等判断。
 * 认证与令牌签名用的是 HKDF/SHA-256（见 src/domain/identity/token.ts），与本文件无关。
 * 换句话说：不要因为"MD5 已破"就以为这里不安全——攻击者能构造碰撞也只影响他自己那个
 * 对象的版本号；版本号不是权限凭据（权限由 read/write 位与租户判定）。
 *
 * 正确性证据：
 *  - `tests/unit/md5.test.ts` 用 RFC 1321 附录 A.5 的全部测试向量；
 *  - `tests/e2e/storage.e2e.test.ts` 用 Node 的 `crypto.createHash("md5")` 对同一批值
 *    交叉验证 Worker 返回的 `version`（跨实现比对，不是自我一致）。
 */

const SHIFTS = new Uint8Array([
  // 四轮的左移位数：与 RFC 1321 的表格逐行对应。
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

/**
 * 常数表 K[i] = floor(2^32 * |sin(i + 1)|)。
 *
 * 这里**按定义算**而不是抄 64 个魔数：抄错一个数字只会让哈希静默算错，
 * 而按定义计算的结果可以用 RFC 向量整体验收。
 */
const K = ((): Uint32Array => {
  const table = new Uint32Array(64);
  for (let index = 0; index < 64; index += 1) {
    table[index] = Math.floor(Math.abs(Math.sin(index + 1)) * 4294967296) >>> 0;
  }
  return table;
})();

function rotl(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

/** RFC 1321 §3.4 的四轮运算，用同一段代码跑 64 步（省掉四份抄写错误的机会）。 */
function step(state: Uint32Array, block: Uint32Array): void {
  let a = state[0] as number;
  let b = state[1] as number;
  let c = state[2] as number;
  let d = state[3] as number;

  for (let index = 0; index < 64; index += 1) {
    const round = index >> 4; // 0..3
    let f: number;
    let g: number;
    if (round === 0) {
      f = (b & c) | (~b & d);
      g = index;
    } else if (round === 1) {
      f = (d & b) | (~d & c);
      g = (5 * index + 1) % 16;
    } else if (round === 2) {
      f = b ^ c ^ d;
      g = (3 * index + 5) % 16;
    } else {
      f = c ^ (b | ~d);
      g = (7 * index) % 16;
    }

    const temp = d;
    d = c;
    c = b;
    const sum = (a + f + (K[index] as number) + (block[g] as number)) >>> 0;
    b = (b + rotl(sum, SHIFTS[index] as number)) >>> 0;
    a = temp;
  }

  state[0] = ((state[0] as number) + a) >>> 0;
  state[1] = ((state[1] as number) + b) >>> 0;
  state[2] = ((state[2] as number) + c) >>> 0;
  state[3] = ((state[3] as number) + d) >>> 0;
}

function utf8Bytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

/** 返回 16 字节摘要。 */
export function md5(input: string | Uint8Array): Uint8Array {
  const bytes = typeof input === "string" ? utf8Bytes(input) : input;
  const originalBits = bytes.length * 8;

  // 填充：0x80 + 若干 0x00，使长度 ≡ 56 (mod 64)，末尾 8 字节写入原始比特长度（小端）。
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  // 长度是 64 位小端；JS 的安全整数在 2^53 以内足够，高 32 位单独写。
  const lowBits = originalBits >>> 0;
  const highBits = Math.floor(originalBits / 4294967296) >>> 0;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, lowBits, true);
  view.setUint32(paddedLength - 4, highBits, true);

  const state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  const block = new Uint32Array(16);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      block[index] = view.getUint32(offset + index * 4, true);
    }
    step(state, block);
  }

  const digest = new Uint8Array(16);
  const digestView = new DataView(digest.buffer);
  for (let index = 0; index < 4; index += 1) {
    digestView.setUint32(index * 4, state[index] as number, true);
  }
  return digest;
}

/** 小写十六进制摘要——存储 `version` 用的就是这个形状。 */
export function md5Hex(input: string | Uint8Array): string {
  let hex = "";
  for (const byte of md5(input)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
