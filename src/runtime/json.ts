/**
 * `nk.jsonEncode` / `nk.jsonDecode`（上游 Lua 那份 `json_encode` / `json_decode` 的等价物）。
 *
 * 语义差异只有一处需要说清楚：**键序**。上游走 Go 的 `encoding/json.Marshal`，
 * 它把 `map[string]any` 的键**按字节序升序**输出，于是
 * `json_encode(json_decode('{"key":"value"}'))` 原样回 `{"key":"value"}` 这件事
 * 在单键上看起来理所当然，在多键上却是"排序过的"。
 * `JSON.stringify` 保持插入序，两者会在多键对象上不一致，所以这里自己排一遍。
 *
 * 顺带对齐 Go 的 HTML 转义（`<` / `>` / `&` 输出成 `\u003c` / `\u003e` / `\u0026`），
 * 以及 `U+2028` / `U+2029` 的转义——这两条是"输出字节级不同、语义相同"的差异，
 * 之所以也照做，是因为模块作者可能把编码结果当**缓存键**用，字节不同就是不同键。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime_test.go::TestRuntimeJson
 * 契约源: server/runtime_lua_nakama.go::RuntimeLuaNakamaModule.jsonEncode
 * 契约源: server/runtime_lua_nakama.go::RuntimeLuaNakamaModule.jsonDecode
 *
 * REQ-0001-020
 */

function escapeHtml(text: string): string {
  return text
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Go 的 `encoding/json` 形状的序列化：对象键升序、无多余空白、HTML 转义。
 *
 * `undefined` 在 JSON 里没有对应物，按 Go 对 `nil` 的处理写成 `null`（数组元素与
 * 对象值都是）；函数与 symbol 同样写成 `null`，避免出现"键悄悄消失"的隐式行为。
 */
export function jsonEncode(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "function" || typeof value === "symbol") return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return escapeHtml(JSON.stringify(value));
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => jsonEncode(item)).join(",")}]`;
  }
  if (value instanceof Uint8Array) {
    return `[${Array.from(value).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const body = entries
    .map(([key, item]) => `${escapeHtml(JSON.stringify(key))}:${jsonEncode(item)}`)
    .join(",");
  return `{${body}}`;
}

/** 解析失败抛 `Error`（上游是 `RaiseError("not a valid JSON string: ...")`）。 */
export function jsonDecode(text: string): unknown {
  if (text === "") throw new Error("expects JSON string");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`not a valid JSON string: ${(error as Error).message}`);
  }
}
