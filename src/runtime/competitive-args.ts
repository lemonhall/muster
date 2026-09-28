/**
 * 竞技面的 `nk.*` 参数解析：把 JS 侧传进来的值折成领域层的类型。
 *
 * 单独成文件的理由只有一个：**报错文案是契约**。模块作者会按这些字符串写 catch
 * 分支，而它们分散在四个 `nk.*` 函数里，抄在四处早晚会漂。两处最容易"顺手修好"
 * 的地方逐字照抄上游：
 *   - 布尔参数必须是**真布尔**（上游 `getJsBool` 对 `1` / `"true"` 直接抛
 *     `expects boolean`，不做 truthy 折算）；
 *   - operator 的非法值文案把枚举顺序写成 `'best', 'set', 'decr' or 'incr'`，
 *     与它接受的四个取值的顺序并不一致。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime_javascript_nakama.go::getJsBool
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.leaderboardCreate
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.leaderboardRecordWrite
 *
 * REQ-0001-015
 */

import { LeaderboardOperator, SortOrder } from "../domain/competitive/leaderboard/definition";
import { parseCron } from "../domain/competitive/cron/expression";
import { normalizeUserId } from "../realtime/identifiers";

/** `api.Operator`：写入请求里能覆盖榜单 operator 的那一组取值（与榜单那套编号不同）。 */
export const ApiOperator = { NoOverride: 0, Best: 1, Set: 2, Increment: 3, Decrement: 4 } as const;

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 上游 `getJsBool`：不是布尔就抛，**不做** truthy 折算。 */
export function boolOf(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("expects boolean");
  return value;
}

export function optionalBool(value: unknown, fallback: boolean): boolean {
  return value === undefined || value === null ? fallback : boolOf(value);
}

export function intOf(value: unknown, fallback: number): number {
  return typeof value === "number" ? Math.trunc(value) : fallback;
}

export function optionalInt(value: unknown, fallback: number): number {
  return value === undefined || value === null ? fallback : intOf(value, fallback);
}

export function optionalText(value: unknown): string {
  return value === undefined || value === null ? "" : text(value);
}

/** 上游 `f.Argument(n).Export().(map[string]any)`：数组也是对象，但上游不收数组。 */
export function metadataText(value: unknown): string {
  if (value === undefined || value === null) return "{}";
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expects metadata to be an object");
  }
  return JSON.stringify(value);
}

export function sortOrderOf(value: unknown): number {
  switch (text(value)) {
    case "asc":
    case "ascending":
      return SortOrder.Ascending;
    case "desc":
    case "descending":
      return SortOrder.Descending;
    default:
      throw new TypeError("expects sort order to be 'asc' or 'desc'");
  }
}

export function operatorOf(value: unknown): number {
  switch (text(value)) {
    case "best":
      return LeaderboardOperator.Best;
    case "set":
      return LeaderboardOperator.Set;
    case "incr":
    case "increment":
      return LeaderboardOperator.Increment;
    case "decr":
    case "decrement":
      return LeaderboardOperator.Decrement;
    default:
      throw new TypeError("expects operator to be 'best', 'set', 'decr' or 'incr'");
  }
}

/** 重置表达式在入口就解析一次：坏表达式属于"模块写错了"，不是运行时故障。 */
export function resetScheduleOf(value: unknown): string {
  const source = value === undefined || value === null ? "" : text(value);
  if (source !== "") {
    // 上游把解析器的原始错误换成这一句 TypeError，模块侧的 catch 只认这一句。
    try {
      parseCron(source);
    } catch {
      throw new TypeError("expects reset schedule to be a valid CRON expression");
    }
  }
  return source;
}

/** 上游用 `uuid.FromString`：带连字符 / 无连字符 / `urn:uuid:` / 花括号都认。 */
export function ownerIdOf(value: unknown): string {
  const owner = normalizeUserId(text(value));
  if (owner === null) throw new TypeError("expects owner ID to be a valid identifier");
  return owner;
}

/** `nk.leaderboardRecordWrite` 的第 7 个参数：`""` / 缺省都是"不覆盖"。 */
export function overrideOperatorOf(value: unknown): number {
  if (value === undefined || value === null) return ApiOperator.NoOverride;
  switch (text(value).toLowerCase()) {
    case "best":
      return ApiOperator.Best;
    case "set":
      return ApiOperator.Set;
    case "incr":
    case "increment":
      return ApiOperator.Increment;
    case "decr":
    case "decrement":
      return ApiOperator.Decrement;
    default:
      throw new TypeError("operator must be one of 'best', 'set', 'incr' or 'decr'");
  }
}
