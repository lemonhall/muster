/**
 * `nk` 的工具函数面：摘要、编解码、AES-128、口令哈希、UUID。
 *
 * 逐条对齐上游两份实现里同名函数的**可观测行为**（Lua 与 JS 各有实现，两者一致
 * 的部分照抄，不一致的地方取 Lua 那份，因为覆盖矩阵引用的 `runtime_test.go`
 * 全是 Lua 断言）：
 *
 * - `md5Hash("test")` = `098f6bcd4621d373cade4e832627b4f6`、`sha256Hash("test")` =
 *   `9f86d081...0a08`（十六进制小写）；
 * - `base64*` / `base16*` 往返回原串；**空串会被拒**（Lua 那份 `l.ArgError(1, "expects string")`，
 *   JS 那份放行——取 Lua 的严）；
 * - `aes128Encrypt` 的 key 长度必须**正好 16 字节**（按 UTF-8 字节数算，不是字符数），
 *   明文先补空格到 4 的倍数，随机 IV 16 字节前置，密文整体走标准 base64；
 *   解密后**不去掉补齐的空格**——上游不去，调用方自己 `trim`（测试里就是 `TrimSpace`）；
 * - `bcryptHash` / `bcryptCompare` 用 PBKDF2-SHA256 取代 bcrypt（workerd 没有 bcrypt，
 *   见 [ECN-0012](../../docs/ecn/ECN-0012-runtime-modules-on-worker-loader.md) 偏差 6
 *   与 [ECN-0002](../../docs/ecn/ECN-0002-password-hash.md)）；
 * - `uuidv4` 小写标准形。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime_test.go::TestRuntimeMD5Hash
 * 契约源: server/runtime_test.go::TestRuntimeSHA256Hash
 * 契约源: server/runtime_test.go::TestRuntimeBase64
 * 契约源: server/runtime_test.go::TestRuntimeBase16
 * 契约源: server/runtime_test.go::TestRuntimeAes128
 * 契约源: server/runtime_test.go::TestRuntimeBcryptHash
 * 契约源: server/runtime_test.go::TestRuntimeBcryptCompare
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.aesEncrypt
 *
 * REQ-0001-020
 */

import { md5Hex } from "../domain/storage/md5";
import { uuidV4 } from "../domain/uuid";
import { aesCfbDecrypt, aesCfbEncrypt } from "./aes-cfb";

const AES128_KEY_BYTES = 16;
const AES128_IV_BYTES = 16;
const PAD_BYTES = 4;
const PAD_CHAR = 0x20; // 上游补的是空格，不是 PKCS#7
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_HASH_BYTES = 32;
const PBKDF2_PREFIX = "pbkdf2-sha256";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8Bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

export function utf8Text(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0) throw new Error(`Failed to decode string: ${value}`);
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const pair = value.slice(index * 2, index * 2 + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) throw new Error(`Failed to decode string: ${value}`);
    bytes[index] = Number.parseInt(pair, 16);
  }
  return bytes;
}

/** 二进制 → 标准 base64（有填充），与 Go 的 `base64.StdEncoding` 一致。 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string, padded: boolean): Uint8Array {
  let normalized = value;
  if (padded) {
    const remainder = normalized.length % 4;
    if (remainder !== 0) normalized += "=".repeat(4 - remainder);
  }
  let binary: string;
  try {
    binary = atob(normalized);
  } catch {
    throw new Error(`Failed to decode string: ${value}`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function md5Hash(input: string): string {
  return md5Hex(input);
}

export async function sha256Hash(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8Bytes(input));
  return toHex(new Uint8Array(digest));
}

function requireNonEmpty(input: string): void {
  if (input === "") throw new Error("expects string");
}

export function base64Encode(input: string, padding = true): string {
  requireNonEmpty(input);
  const encoded = toBase64(utf8Bytes(input));
  return padding ? encoded : encoded.replace(/=+$/, "");
}

export function base64Decode(input: string, padding = true): string {
  requireNonEmpty(input);
  return utf8Text(fromBase64(input, padding));
}

export function base64UrlEncode(input: string, padding = true): string {
  requireNonEmpty(input);
  const encoded = toBase64(utf8Bytes(input)).replace(/\+/g, "-").replace(/\//g, "_");
  return padding ? encoded : encoded.replace(/=+$/, "");
}

/**
 * 上游 Lua 那份在 `padding = false` 时把"补不补 = 号"写反了
 * （`if !padding { pad }`，而 `base64Decode` 是 `if padding { pad }`）——那是个笔误，
 * 我们按"需要补就补"实现，不做字节级复刻：没有客户端会依赖"关掉补齐反而补齐"。
 */
export function base64UrlDecode(input: string, padding = true): string {
  requireNonEmpty(input);
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  return utf8Text(fromBase64(normalized, padding));
}

export function base16Encode(input: string): string {
  requireNonEmpty(input);
  return toHex(utf8Bytes(input));
}

export function base16Decode(input: string): string {
  requireNonEmpty(input);
  return utf8Text(fromHex(input));
}

/** 补齐到 `PAD_BYTES` 的倍数；已经对齐就原样返回（上游用 `len(input) % 4` 判断）。 */
function padToFour(bytes: Uint8Array): Uint8Array {
  const remainder = bytes.length % PAD_BYTES;
  if (remainder === 0) return bytes;
  const padded = new Uint8Array(bytes.length + (PAD_BYTES - remainder));
  padded.set(bytes);
  padded.fill(PAD_CHAR, bytes.length);
  return padded;
}

export function aes128Encrypt(input: string, key: string): string {
  const keyBytes = utf8Bytes(key);
  if (keyBytes.length !== AES128_KEY_BYTES) {
    throw new Error(`expects key ${AES128_KEY_BYTES} bytes long`);
  }
  const iv = crypto.getRandomValues(new Uint8Array(AES128_IV_BYTES));
  const cipher = aesCfbEncrypt(keyBytes, iv, padToFour(utf8Bytes(input)));
  const combined = new Uint8Array(iv.length + cipher.length);
  combined.set(iv);
  combined.set(cipher, iv.length);
  return toBase64(combined);
}

/** **不去掉补齐的空格**：上游原样返回，调用方自己 trim（测试里的 `TrimSpace`）。 */
export function aes128Decrypt(input: string, key: string): string {
  const keyBytes = utf8Bytes(key);
  if (keyBytes.length !== AES128_KEY_BYTES) {
    throw new Error(`expects key ${AES128_KEY_BYTES} bytes long`);
  }
  const combined = fromBase64(input, true);
  const iv = combined.slice(0, AES128_IV_BYTES);
  const cipher = combined.slice(AES128_IV_BYTES);
  return utf8Text(aesCfbDecrypt(keyBytes, iv, cipher));
}

export async function bcryptHash(input: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const derived = await derive(salt, input);
  return [PBKDF2_PREFIX, String(PBKDF2_ITERATIONS), toBase64(salt), toBase64(derived)].join("$");
}

export async function bcryptCompare(hash: string, input: string): Promise<boolean> {
  const parts = hash.split("$");
  if (parts.length !== 4 || parts[0] !== PBKDF2_PREFIX) return false;
  const iterations = Number.parseInt(parts[1] ?? "", 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64(parts[2] ?? "", true);
    expected = fromBase64(parts[3] ?? "", true);
  } catch {
    return false;
  }
  const derived = await derive(salt, input, iterations);
  if (derived.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < derived.length; index += 1) {
    diff |= (derived[index] ?? 0) ^ (expected[index] ?? 0);
  }
  return diff === 0;
}

async function derive(
  salt: Uint8Array,
  input: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", utf8Bytes(input), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    PBKDF2_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export function uuidv4(): string {
  return uuidV4();
}
