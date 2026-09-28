/**
 * base64url 编解码（无填充）。
 *
 * 本项目的**不透明游标**统一是 base64url(JSON)：上游用的是 Go 的 gob，
 * 我们显然无法也不该复刻 gob 字节流（见 docs/ecn/ECN-0004-storage-cursor-encoding.md）。
 * 游标对客户端不可解析，所以换编码是实现自由；能看见的只有"坏游标报什么错"。
 *
 * 之所以单独成文件：存储、好友、群组、通知四处都要用，抄四遍就是四个走样的机会。
 */

export function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

/** 上限只是为了让"有人拿 1MB 的串当游标"这件事在解析前就被挡住。 */
export const MAX_CURSOR_LENGTH = 4096;
