/**
 * AES-128 + CFB（全块反馈）的自实现。
 *
 * 为什么要自己写：上游的 `aes128_encrypt` / `aes128_decrypt` 用的是 Go 的
 * `crypto/aes` + `crypto/cipher.NewCFBEncrypter`。workerd 的 WebCrypto 只提供
 * AES-CBC / AES-CTR / AES-GCM，**没有 CFB**。密文要与上游互换（同一个 key 加出来的
 * 串能被上游解开），所以模式选不了替代品——只能把块加密与 CFB 自己实现。
 * 登记为 [ECN-0012](../../docs/ecn/ECN-0012-runtime-modules-on-worker-loader.md) 偏差 7。
 *
 * 与 Go 对齐的三个细节（抄错任何一个密文就不通）：
 *
 * 1. **全块 CFB**（`cipher.NewCFBEncrypter`，段长 = 128 位），不是 CFB-8；
 * 2. 最后一块可以**不满 16 字节**：只产生这么多字节的密文，寄存器只更新这么多字节
 *    （Go 的 `cfb.XORKeyStream` 就是这么写的）；
 * 3. 寄存器在加/解密两个方向上**都**被写入"密文那一侧"的字节。
 *
 * 正确性证据：FIPS-197 的 AES-128 单块测试向量（key `000102...0f`、
 * 明文 `00112233...ff` → 密文 `69c4e0d8...c55a`）在
 * `tests/unit/runtime/aes-cfb.test.ts` 里逐字节比对。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.aesEncrypt
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.aesDecrypt
 *
 * REQ-0001-020
 */

const BLOCK = 16;
const ROUNDS = 10;

// prettier-ignore
const SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

function xtime(value: number): number {
  const doubled = value << 1;
  return (doubled ^ (doubled & 0x100 ? 0x1b : 0)) & 0xff;
}

/** 128 位密钥扩展成 11 组轮密钥（176 字节）。 */
export function expandKey(key: Uint8Array): Uint8Array {
  if (key.length !== BLOCK) throw new RangeError("AES-128 needs a 16 byte key");
  const words = new Uint8Array(BLOCK * (ROUNDS + 1));
  words.set(key);
  let rcon = 0x01;
  for (let offset = BLOCK; offset < words.length; offset += 4) {
    const previous = offset - 4;
    let t0 = words[previous] ?? 0;
    let t1 = words[previous + 1] ?? 0;
    let t2 = words[previous + 2] ?? 0;
    let t3 = words[previous + 3] ?? 0;
    if (offset % BLOCK === 0) {
      const rotate = t0;
      t0 = SBOX[t1]! ^ rcon;
      t1 = SBOX[t2]!;
      t2 = SBOX[t3]!;
      t3 = SBOX[rotate]!;
      rcon = xtime(rcon);
    }
    words[offset] = (words[offset - BLOCK] ?? 0) ^ t0;
    words[offset + 1] = (words[offset - BLOCK + 1] ?? 0) ^ t1;
    words[offset + 2] = (words[offset - BLOCK + 2] ?? 0) ^ t2;
    words[offset + 3] = (words[offset - BLOCK + 3] ?? 0) ^ t3;
  }
  return words;
}

function addRoundKey(state: Uint8Array, words: Uint8Array, round: number): void {
  const base = round * BLOCK;
  for (let index = 0; index < BLOCK; index += 1) {
    state[index] = (state[index] ?? 0) ^ (words[base + index] ?? 0);
  }
}

function subBytes(state: Uint8Array): void {
  for (let index = 0; index < BLOCK; index += 1) state[index] = SBOX[state[index]!]!;
}

/**
 * 行移位：第 r 行循环左移 **r** 个字节（不是每个都移 1 个——
 * 那是抄这个函数时最常见的错，FIPS-197 的向量会立刻抓到）。状态是列优先（`s[r + 4c]`）。
 */
function shiftRows(state: Uint8Array): void {
  for (let row = 1; row < 4; row += 1) {
    const column = [state[row]!, state[row + 4]!, state[row + 8]!, state[row + 12]!];
    for (let index = 0; index < 4; index += 1) {
      state[row + 4 * index] = column[(index + row) % 4]!;
    }
  }
}

function mixColumns(state: Uint8Array): void {
  for (let column = 0; column < 4; column += 1) {
    const base = column * 4;
    const a0 = state[base]!;
    const a1 = state[base + 1]!;
    const a2 = state[base + 2]!;
    const a3 = state[base + 3]!;
    state[base] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
    state[base + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
    state[base + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
    state[base + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
  }
}

/** 单块加密：CFB 只用到这一个方向，所以不需要逆 S 盒与逆变换。 */
export function encryptBlock(words: Uint8Array, input: Uint8Array): Uint8Array {
  const state = input.slice(0, BLOCK);
  addRoundKey(state, words, 0);
  for (let round = 1; round < ROUNDS; round += 1) {
    subBytes(state);
    shiftRows(state);
    mixColumns(state);
    addRoundKey(state, words, round);
  }
  subBytes(state);
  shiftRows(state);
  addRoundKey(state, words, ROUNDS);
  return state;
}

/**
 * CFB-128 的一次流变换。加密与解密只差"寄存器写哪一侧"，
 * 而两侧本来就是同一个值（密文），所以共用一个循环。
 */
function cfbTransform(
  words: Uint8Array,
  iv: Uint8Array,
  input: Uint8Array,
  decrypt: boolean,
): Uint8Array {
  const output = new Uint8Array(input.length);
  const register = iv.slice(0, BLOCK);
  let offset = 0;
  while (offset < input.length) {
    const stream = encryptBlock(words, register);
    const length = Math.min(BLOCK, input.length - offset);
    for (let index = 0; index < length; index += 1) {
      const mixed = (input[offset + index]! ^ stream[index]!) & 0xff;
      output[offset + index] = mixed;
      register[index] = decrypt ? input[offset + index]! : mixed;
    }
    offset += length;
  }
  return output;
}

export function aesCfbEncrypt(key: Uint8Array, iv: Uint8Array, plain: Uint8Array): Uint8Array {
  return cfbTransform(expandKey(key), iv, plain, false);
}

export function aesCfbDecrypt(key: Uint8Array, iv: Uint8Array, cipher: Uint8Array): Uint8Array {
  return cfbTransform(expandKey(key), iv, cipher, true);
}
