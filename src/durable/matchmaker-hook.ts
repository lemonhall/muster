/**
 * `matchmaker_matched` 钩子：成局之后"给 match id 还是给 token"的那个决定。
 *
 * 上游的这条决定来自**运行时回调**（`runtime.MatchmakerMatched()`）：游戏模块里注册的
 * 函数看一遍 `entries`，想自己开一场权威对局就返回 match id，不想就用 token 让客户端
 * 去开一场中继对局。上游测试里的那个回调写的是：
 *
 * ```go
 * if len(entries) != 2 { return "", false, nil }
 * if !isModeAuthoritative(entries[0].Properties) { return "", false, nil }
 * if !isModeAuthoritative(entries[1].Properties) { return "", false, nil }
 * return matchRegistry.CreateMatch(...), true, nil
 * ```
 *
 * 运行时的模块系统在 M8 才落地，但"成局结果由谁决定"这条**可观测契约**在 M7 就得有。
 * 所以这里把那个回调的判定能力收成一个**声明式**的钩子：人数要对得上、每个参与者都要
 * 带着指定的字符串属性。等 M8 的运行时接通，它注册的回调会复用同一个入口（把决定权
 * 交回给模块），而不是推翻这一层。
 *
 * 契约源（机器可读）：
 * 契约源: server/matchmaker.go::LocalMatchmaker.Process
 *
 * REQ-0001-017
 */

import type { MatchmakerEntry } from "../domain/matchmaker/types";

export interface MatchedHook {
  /** 人数必须恰好是这个值（上游那三条 `len(entries) != 2` 的等价物）。 */
  readonly size: number;
  /** 每个参与者都必须带上这些**字符串属性**（值按 JSON 文本比较）。 */
  readonly match: Readonly<Record<string, string>>;
  /** 建出来的权威对局用的标签（不给就是空串，与上游 `CreateMatch` 的默认一致）。 */
  readonly label?: string;
}

/** 钩子同意"这一局开权威对局"吗。 */
export function hookMatches(hook: MatchedHook, entries: readonly MatchmakerEntry[]): boolean {
  if (entries.length !== hook.size) return false;
  for (const entry of entries) {
    for (const [key, value] of Object.entries(hook.match)) {
      const actual = entry.properties[key];
      // 数值属性与字符串属性都允许命中：钩子的值写成字符串，这里按字面比较。
      if (actual === undefined || String(actual) !== value) return false;
    }
  }
  return true;
}

/** 解析 `/hook` 的请求体；形状不对返回 null（"清掉钩子"），而不是猜一个出来。 */
export function readHook(raw: unknown): MatchedHook | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const size = record["size"];
  const match = record["match"];
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) return null;
  if (typeof match !== "object" || match === null || Array.isArray(match)) return null;
  const pairs: Record<string, string> = {};
  for (const [key, value] of Object.entries(match as Record<string, unknown>)) {
    if (typeof value === "string") pairs[key] = value;
  }
  const label = record["label"];
  return {
    size,
    match: pairs,
    ...(typeof label === "string" ? { label } : {}),
  };
}
