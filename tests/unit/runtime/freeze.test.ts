import { describe, expect, it } from "vitest";

import { freezeGlobals, isFrozenGlobals } from "../../../src/runtime/freeze";

/**
 * 冻结全局命名空间的契约测试。
 *
 * 上游三个子用例（`server/runtime_javascript_test.go::TestJsObjectFreeze`）钉的是
 * goja 的全局对象语义：冻结后不能新增全局变量、既有全局对象不可改、新建对象仍可变。
 * 标准 JS 没有"模块顶层 var 落进全局对象"这件事，所以这里用一个普通对象充当
 * 命名空间，逐条复刻那三条**等价**语义（ECN-0012 偏差 8）。
 *
 * 溯源: server/runtime_javascript_test.go::TestJsObjectFreeze
 */

describe("M8 冻结全局", () => {
  it("test_after_freeze_new_namespace_members_cannot_be_created", () => {
    const namespace: Record<string, unknown> = { logger: { level: "info" } };
    freezeGlobals(namespace);

    expect(isFrozenGlobals(namespace)).toBe(true);
    expect(() => {
      "use strict";
      namespace["k"] = "new string";
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(namespace, "k2", { value: 1 })).toThrow(TypeError);
    expect("k" in namespace).toBe(false);
    expect("k2" in namespace).toBe(false);
  });

  it("test_after_freeze_existing_globals_become_immutable", () => {
    const namespace: Record<string, unknown> = {};
    const holder = { foo: "bar" };
    namespace["m"] = holder;

    freezeGlobals(namespace);

    expect(() => {
      "use strict";
      holder.foo = "baz";
    }).toThrow(TypeError);
    expect(holder.foo).toBe("bar");
  });

  it("test_after_freeze_newly_instanced_objects_stay_mutable", () => {
    const namespace: Record<string, unknown> = {};
    freezeGlobals(namespace);

    const created = new Map<string, number>();
    created.set("a", 1);
    expect(created.get("a")).toBe(1);

    const plain = { list: [] as number[] };
    plain.list.push(7);
    expect(plain.list).toEqual([7]);
  });
});
