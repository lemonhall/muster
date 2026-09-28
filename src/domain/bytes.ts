/**
 * 二进制载荷的标准 base64 编解码。
 *
 * 为什么要它：`match_data_send` 的 `data` 是 `bytes`，而 DO 之间只能通过 JSON 说话
 * （`durable/match-call.ts`）。protojson 对 `bytes` 用的就是标准 base64（RFC 4648，
 * 带填充），所以这一层选同一种编码：**跨 DO 的载荷与线上帧的字节完全同形**，
 * 排查时把两边打印出来直接就能对上。
 *
 * 与 `base64url.ts` 分开而不是塞进它：那个是"不透明游标"的编码（无填充、URL 安全），
 * 这个是协议字节的编码，两者的取值集合不同，混用会让 `+` / `/` 变成 `-` / `_`。
 */

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
