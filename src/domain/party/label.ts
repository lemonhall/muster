/**
 * 派对标签的解析规则：长度、JSON 形状、以及"隐藏派对不许带非空标签"。
 *
 * 上游把标签解进 `map[string]any`，所以"合法"的判据是**JSON 对象**：
 * `{"a":1}` 行，`[1]`、`"x"`、`42` 都不行，而 `null` 行（Go 解进 map 得到 nil map，
 * 不报错）。这条边界很容易抄错——`JSON.parse` 成功不等于上游接受。
 *
 * 三处失败文案与上游一一对应：
 * - 超长 → `runtime.ErrPartyLabelTooLong`（`party label too long`）；
 * - 语法坏 → `failed to unmarshal party label: <解析器的话>`；
 * - 形状不对 → `failed to unmarshal party label: json: cannot unmarshal <类型> into
 *   Go value of type map[string]interface {}`（这句逐字照抄 Go `encoding/json`）。
 *
 * 语法坏那一条的**细节**是已知偏差：上游的细节来自 Go `encoding/json`（`invalid
 * character 'a' looking for beginning of value`），这里只能给 JS 引擎的话。前缀一致、
 * 细节不同，记在 ECN-0013 偏差 4；形状不对那一条是全字对齐的。
 *
 * 契约源（机器可读）：
 * 契约源: server/party_registry.go::LocalPartyRegistry.Create
 * 契约源: server/party_registry.go::LocalPartyRegistry.LabelUpdate
 *
 * REQ-0001-019
 */

import { byteLength } from "../identity/service/validate";
import { PARTY_LABEL_MAX_BYTES } from "./types";

export type PartyLabelProblem =
  | { readonly kind: "label-too-long" }
  | { readonly kind: "label-invalid"; readonly message: string };

/** 上游在创建/更新时把空串规整成 `{}`——存的是规整后的那一份。 */
export function storedLabel(raw: string): string {
  return raw === "" ? "{}" : raw;
}

/** 隐藏派对只允许空标签或 `{}`（上游 `ErrPartyHiddenNonEmptyLabel` 的判据）。 */
export function hiddenNonEmptyLabel(label: string, hidden: boolean): boolean {
  return hidden && label !== "" && label !== "{}";
}

function goKindOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value === "object" ? "object" : typeof value;
}

export function parsePartyLabel(raw: string): PartyLabelProblem | null {
  const normalized = storedLabel(raw);
  if (byteLength(normalized) > PARTY_LABEL_MAX_BYTES) return { kind: "label-too-long" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: "label-invalid", message: `failed to unmarshal party label: ${detail}` };
  }
  // Go 的 `json.Unmarshal(..., &map[string]any{})` 接受 null，这里同样放行。
  if (parsed === null) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      kind: "label-invalid",
      message:
        `failed to unmarshal party label: json: cannot unmarshal ${goKindOf(parsed)} ` +
        "into Go value of type map[string]interface {}",
    };
  }
  return null;
}
