/**
 * base64url 编解码（无填充）。
 *
 * 本项目的**不透明游标**统一是 base64url(JSON)：上游用的是 Go 的 gob，
 * 我们显然无法也不该复刻 gob 字节流（见 docs/ecn/ECN-0004-storage-cursor-encoding.md）。
 * 游标对客户端不可解析，所以换编码是实现自由；能看见的只有"坏游标报什么错"。
 *
 * 之所以单独成文件：存储、好友、群组、通知四处都要用，抄四遍就是四个走样的机会。
 */

/**
 * 字节 → base64url（无填充）。
 *
 * 与下面那个文本版分开的原因和 `fromBase64UrlBytes` 对称：**签名是二进制**，
 * 先 `String.fromCharCode` 走一趟再让文本版按 UTF-8 编码回去，0x80 以上的字节
 * 会被编成两个字节，签名就毁了。凡是"手上有 `Uint8Array`"的场合都必须走这个入口。
 */
export function toBase64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function toBase64Url(text: string): string {
  return toBase64UrlBytes(new TextEncoder().encode(text));
}

export function fromBase64Url(value: string): string {
  return new TextDecoder().decode(fromBase64UrlBytes(value));
}

/**
 * base64url → 原始字节。
 *
 * 游标只需要文本，但 JWS 的签名段是**二进制**：先解成文本再编码回去会毁掉它
 * （0x80 以上的字节在 UTF-8 解码时会被替换成 U+FFFD）。所以两个入口分开。
 */
export function fromBase64UrlBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** 上限只是为了让"有人拿 1MB 的串当游标"这件事在解析前就被挡住。 */
export const MAX_CURSOR_LENGTH = 4096;
