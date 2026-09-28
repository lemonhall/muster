/**
 * index_only 投影：把对象的 value 裁成"只含索引声明里列出的字段"，再按**键名升序**
 * 序列化。
 *
 * 键名排序不是我们的偏好，而是上游的行为：Go 的 `json.Marshal` 对 map 就是按键名排序，
 * 上游 `mapIndexStorageFields` 把 `filteredValues` 直接 Marshal 进索引的 `json` 字段，
 * 而 index_only 列表返回的就是这份字节。
 */

/** 递归按键名升序序列化：与 Go `json.Marshal(map[string]any)` 的输出形状一致。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * 裁剪 + 序列化。返回 null 表示"这个对象进不了这个索引"（上游 `mapIndexStorageFields`
 * 在 value 不是 JSON 对象、或过滤后一个字段都不剩时返回 nil）。
 */
export function projectValue(value: string, fields: readonly string[]): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const source = parsed as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  let present = 0;
  for (const field of fields) {
    if (Object.hasOwn(source, field)) {
      picked[field] = source[field];
      present += 1;
    }
  }
  if (present === 0) return null;
  return stableStringify(picked);
}
