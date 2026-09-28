import { describe, expect, it } from "vitest";

import {
  hiddenNonEmptyLabel,
  parsePartyLabel,
  storedLabel,
} from "../../../src/domain/party/label";
import { PARTY_LABEL_MAX_BYTES } from "../../../src/domain/party/types";

/**
 * M8 派对标签的解析规则。
 *
 * 判据全是"Go 的 `json.Unmarshal` 接不接受"，所以每条边界都值得一条用例：
 * `null` 放行、数组/标量不放行、空串被规整成 `{}`、超长按**字节**算。
 *
 * 形状不对那一条的文案是**逐字照抄 Go** 的（`json: cannot unmarshal array into Go
 * value of type map[string]interface {}`）；语法坏那一条的细节只能给 JS 引擎的话，
 * 记在 ECN-0013 偏差 4。
 *
 * 契约源（机器可读）：
 * 契约源: server/party_registry.go::LocalPartyRegistry.Create
 * 契约源: server/party_registry.go::LocalPartyRegistry.LabelUpdate
 *
 * REQ-0001-019
 */

describe("M8 标签: 规整与隐藏校验", () => {
  it("test_empty_label_is_stored_as_an_empty_object", () => {
    expect(storedLabel("")).toBe("{}");
    expect(storedLabel("{\"a\":1}")).toBe("{\"a\":1}");
  });

  it("test_hidden_parties_only_accept_empty_or_empty_object_labels", () => {
    expect(hiddenNonEmptyLabel("", true)).toBe(false);
    expect(hiddenNonEmptyLabel("{}", true)).toBe(false);
    expect(hiddenNonEmptyLabel("{\"a\":1}", true)).toBe(true);
    // 不隐藏就不受这条限制。
    expect(hiddenNonEmptyLabel("{\"a\":1}", false)).toBe(false);
  });
});

describe("M8 标签: 解析边界", () => {
  it("test_objects_and_null_are_accepted", () => {
    expect(parsePartyLabel("")).toBeNull();
    expect(parsePartyLabel("{}")).toBeNull();
    expect(parsePartyLabel("{\"region\":\"eu\",\"level\":3}")).toBeNull();
    // Go 把 null 解进 map 得到 nil map，不报错。
    expect(parsePartyLabel("null")).toBeNull();
  });

  it("test_non_object_shapes_report_go_wording", () => {
    expect(parsePartyLabel("[1,2]")).toEqual({
      kind: "label-invalid",
      message:
        "failed to unmarshal party label: json: cannot unmarshal array " +
        "into Go value of type map[string]interface {}",
    });
    expect(parsePartyLabel("\"x\"")).toEqual({
      kind: "label-invalid",
      message:
        "failed to unmarshal party label: json: cannot unmarshal string " +
        "into Go value of type map[string]interface {}",
    });
    expect(parsePartyLabel("42")).toEqual({
      kind: "label-invalid",
      message:
        "failed to unmarshal party label: json: cannot unmarshal number " +
        "into Go value of type map[string]interface {}",
    });
  });

  it("test_syntax_errors_keep_the_prefix_but_the_detail_comes_from_the_js_engine", () => {
    const problem = parsePartyLabel("{not json}");
    expect(problem?.kind).toBe("label-invalid");
    if (problem?.kind !== "label-invalid") throw new Error("期望 label-invalid");
    expect(problem.message.startsWith("failed to unmarshal party label: ")).toBe(true);
    expect(problem.message.length).toBeGreaterThan("failed to unmarshal party label: ".length);
  });

  it("test_length_limit_is_measured_in_bytes", () => {
    // 2048 字节整好过，2049 就超了。多字节字符按 UTF-8 的字节数算。
    // `{"k":"…"}` 的壳子占 8 字节，所以填充 2040 个字符恰好 2048。
    const filler = "a".repeat(PARTY_LABEL_MAX_BYTES - 8);
    expect(parsePartyLabel(`{"k":"${filler}"}`)).toBeNull();
    expect(parsePartyLabel(`{"k":"${filler}a"}`)).toEqual({ kind: "label-too-long" });
    const wide = "柠".repeat(700); // 2100 字节
    expect(parsePartyLabel(wide)).toEqual({ kind: "label-too-long" });
  });
});
