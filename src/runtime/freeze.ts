/**
 * 冻结全局命名空间（上游 `server/runtime_javascript.go::freezeGlobalObject` 的等价面）。
 *
 * 上游的目的是让模块作者**不能**在全局上偷偷藏状态：goja 的全局对象被设成
 * 不可扩展之后，`var k = 'x'` 会抛
 * `TypeError: Cannot define global variable 'k', global object is not extensible`。
 * 标准 JS 的模块作用域里没有"全局对象可扩展性"这个概念——模块顶层 `var` 落在
 * 模块作用域，既不进 `globalThis` 也不受 `preventExtensions` 约束。所以这一条**不能
 * 逐字复刻**，只能复刻它的**等价面**（登记为 [ECN-0012](../../docs/ecn/ECN-0012-runtime-modules-on-worker-loader.md) 偏差 8）：
 *
 * 1. 冻结**命名空间上已有的对象**：改它们的属性抛 `TypeError`（严格模式）；
 * 2. 命名空间**不可再新增属性**；
 * 3. 冻结之后**新建**的对象仍然可变（`new Map()` 照常用）——这一条与上游一致，
 *    因为上游冻结的也是"当时已有的那些全局"。
 *
 * 之所以把它做成"给一个普通对象"的纯函数，而不是直接动 `globalThis`：测试要能
 * 逐条断言这三条语义，而真的 `Object.preventExtensions(globalThis)` 会把整个
 * isolate 的后续行为一起改掉（那是运行时的活，不是这一层的活）。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime_javascript.go::freezeGlobalObject
 * 契约源: server/runtime_javascript_test.go::TestJsObjectFreeze
 *
 * REQ-0001-020
 */

/**
 * 冻结一个"全局命名空间"对象：既有成员对象被冻结，命名空间本身不可扩展。
 *
 * 顺序是刻意的：先冻成员、后关扩展。反过来也不会错，但这一步的顺序决定了
 * "冻结过程中读到的成员表"是完整的。
 */
export function freezeGlobals(namespace: Record<string, unknown>): void {
  for (const key of Object.keys(namespace)) {
    const value = namespace[key];
    if (value === null) continue;
    if (typeof value !== "object" && typeof value !== "function") continue;
    try {
      Object.freeze(value);
    } catch {
      // 少数宿主对象（如部分内建）不可冻结：跳过它们，不因为一个成员就整体失败。
    }
  }
  Object.preventExtensions(namespace);
}

/** 冻结是否已生效（测试与诊断用，不必靠"试着写一次看抛不抛"来判断）。 */
export function isFrozenGlobals(namespace: Record<string, unknown>): boolean {
  return !Object.isExtensible(namespace);
}
