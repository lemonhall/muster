/**
 * UUID 的两个小工具：v4（随机）与 **v5（按名字派生）**。
 *
 * 为什么需要 v5：上游 `pipeline_match.go::matchCreate` 在客户端给了 `name` 时用
 * `uuid.NewV5(uuid.NamespaceDNS, name)` 派生 match id——于是"同一个名字得到同一个对局"
 * 是契约的一部分（客户端靠重连到同一场）。派生算法是 RFC 4122 的 SHA-1 版本，
 * 一行都不能省：先拼 `namespace_bytes || utf8(name)`，取 SHA-1 的前 16 字节，
 * 再把版本位（第 7 字节高 4 位 = 5）与变体位（第 9 字节高 2 位 = 10）写死。
 *
 * `crypto.subtle.digest("SHA-1", ...)` 在 workerd 里可用，因此不需要自己实现哈希。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_match.go::Pipeline.matchCreate
 *
 * REQ-0001-018
 */

/** `uuid.NamespaceDNS`（RFC 4122 附录 C 里那个固定的 DNS 名字空间）。 */
export const NAMESPACE_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function hexToBytes(hex: string): Uint8Array {
  const digits = hex.replace(/-/g, "");
  const bytes = new Uint8Array(digits.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/** 随机 v4（`crypto.randomUUID()` 的小写标准形）。 */
export function uuidV4(): string {
  return crypto.randomUUID();
}

/** RFC 4122 v5：`SHA-1(namespace || name)` 的前 16 字节。 */
export async function uuidV5(namespace: string, name: string): Promise<string> {
  const namespaceBytes = hexToBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes, 0);
  input.set(nameBytes, namespaceBytes.length);

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}
