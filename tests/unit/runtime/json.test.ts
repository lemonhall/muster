import { describe, expect, it } from "vitest";

import { jsonDecode, jsonEncode } from "../../../src/runtime/json";

/**
 * `nk.jsonEncode` / `nk.jsonDecode` 的契约测试。
 *
 * 上游的核心断言就是那句往返：`json_encode(json_decode(payload)) == payload`。
 * 这条在单键上看着平凡，所以这里额外钉住 Go 侧的两条**字节级**行为：
 * 键按字节序升序、HTML 字符被转义。
 *
 * 溯源: server/runtime_test.go::TestRuntimeJson
 */

describe("M8 nk 工具: JSON", () => {
  it("test_round_trip_of_the_upstream_payload", () => {
    const payload = '{"key":"value"}';
    expect(jsonEncode(jsonDecode(payload))).toBe(payload);
  });

  it("test_object_keys_are_sorted_like_go_marshals_them", () => {
    // Go 的 encoding/json 对 map 按键排序：b 在 a 之前。
    expect(jsonEncode({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("test_nested_objects_are_sorted_too", () => {
    expect(jsonEncode({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it("test_html_characters_are_escaped_like_go", () => {
    expect(jsonEncode({ a: "<>&" })).toBe('{"a":"\\u003c\\u003e\\u0026"}');
  });

  it("test_arrays_keep_their_order", () => {
    expect(jsonEncode([3, 1, 2])).toBe("[3,1,2]");
  });

  it("test_decode_rejects_empty_and_malformed_input", () => {
    expect(() => jsonDecode("")).toThrow(/expects JSON string/);
    expect(() => jsonDecode("{")).toThrow(/not a valid JSON string/);
  });

  it("test_decode_returns_plain_values", () => {
    expect(jsonDecode('{"n":1,"s":"x","b":true,"z":null}')).toEqual({
      n: 1,
      s: "x",
      b: true,
      z: null,
    });
  });
});
