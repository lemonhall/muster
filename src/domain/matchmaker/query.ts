/**
 * 匹配器的查询串：解析与求值。
 *
 * 上游的匹配池是 bluge 全文索引，查询串走 `ParseQueryString`（keyword 分析器）。
 * 本项目**不引入 bluge**（见 ECN-0011 偏差 3），而是实现客户端实际会用到的那一小撮
 * 语法，并把语义逐条对齐：
 *
 * - `*` 或空串 → 匹配全部；
 * - `+field:value` → 必须（must）；`-field:value` → 必须不（must-not）；
 *   不加前缀的子句是**可选**（should）——上游 bluge 默认布尔操作符是 OR，
 *   这与存储索引那条路（`storage_index` 的 OR 语义）是同一套约定；
 * - `field:>=10` / `<=` / `>` / `<` → 数值区间，只对数值属性有意义；
 * - `field:/regex/` → 正则，**整串匹配**（Lucene 的自动机查询是锚定的）；
 * - `field:value^10` → 该子句权重 10，用于排序（分数高者先被选中）；
 * - 没被索引的字段（不是 `properties.` 前缀，或属性里根本没有）→ 恒不匹配，
 *   但保留布尔结构（`+` 的那条挂了，整条查询就挂了）。
 *
 * 数值字段的相等匹配：上游对数值属性既建数值索引又建文本项，所以 `baz:4` 能命中
 * `baz = 4`。这里等价地做成"字符串形式相等 **或** 数值相等"。
 *
 * 契约源（机器可读）：
 * 契约源: server/match_common.go::ParseQueryString
 * 契约源: server/match_common.go::ValidatableQuery
 *
 * REQ-0001-017
 */

/** 属性值的类型：上游 `map[string]any` 里实际会出现的那几种。 */
export type PropertyValue = string | number | boolean | readonly PropertyValue[];

/** 一条查询子句在解析后的形状。 */
interface ClauseBase {
  /** 索引字段路径，例如 `properties.a1` 或 `label.skill`。 */
  readonly field: string;
  readonly required: boolean;
  readonly negative: boolean;
  readonly boost: number;
}

export interface TermClause extends ClauseBase {
  readonly kind: "term";
  readonly value: string;
}

export interface RangeClause extends ClauseBase {
  readonly kind: "range";
  readonly op: ">=" | "<=" | ">" | "<";
  readonly value: number;
}

export interface RegexClause extends ClauseBase {
  readonly kind: "regex";
  readonly pattern: RegExp;
}

export type Clause = TermClause | RangeClause | RegexClause;

export interface MatchmakerQuery {
  readonly source: string;
  /** 空数组 + `matchAll = true` 表示 `*`。 */
  readonly clauses: readonly Clause[];
  readonly matchAll: boolean;
}

/** 查询串解析失败。上游把它归到 `ErrMatchmakerQueryInvalid`。 */
export class QuerySyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuerySyntaxError";
  }
}

const RANGE_PREFIX: Readonly<Record<string, RangeClause["op"]>> = {
  ">=": ">=",
  "<=": "<=",
  ">": ">",
  "<": "<",
};

function parseToken(token: string): Clause {
  let body = token;
  let required = false;
  let negative = false;
  if (body.startsWith("+")) {
    required = true;
    body = body.slice(1);
  } else if (body.startsWith("-")) {
    negative = true;
    body = body.slice(1);
  }

  const separator = body.indexOf(":");
  if (separator <= 0) throw new QuerySyntaxError(`unsupported clause ${JSON.stringify(token)}`);
  const field = body.slice(0, separator);
  let value = body.slice(separator + 1);

  let boost = 1;
  const boostAt = value.lastIndexOf("^");
  if (boostAt > 0) {
    const raw = value.slice(boostAt + 1);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new QuerySyntaxError(`invalid boost in ${JSON.stringify(token)}`);
    boost = parsed;
    value = value.slice(0, boostAt);
  }
  if (value === "") throw new QuerySyntaxError(`empty term in ${JSON.stringify(token)}`);

  const base = { field, required, negative, boost };

  // 正则：整串匹配，与 Lucene 的 AutomatonQuery 一致。
  if (value.length >= 2 && value.startsWith("/") && value.endsWith("/")) {
    const source = value.slice(1, -1);
    let pattern: RegExp;
    try {
      pattern = new RegExp(source);
    } catch {
      throw new QuerySyntaxError(`invalid regex ${JSON.stringify(source)}`);
    }
    return { ...base, kind: "regex", pattern };
  }

  for (const prefix of [">=", "<=", ">", "<"] as const) {
    if (!value.startsWith(prefix)) continue;
    const numeric = Number(value.slice(prefix.length));
    if (!Number.isFinite(numeric)) throw new QuerySyntaxError(`invalid range in ${JSON.stringify(token)}`);
    return { ...base, kind: "range", op: RANGE_PREFIX[prefix] as RangeClause["op"], value: numeric };
  }

  return { ...base, kind: "term", value };
}

/**
 * 解析查询串。`""` 与 `"*"` 等价于"匹配全部"（上游 `pipeline_matchmaker.go` 里
 * 空串会被改写成 `*`，这里两处都接受）。
 */
export function parseMatchmakerQuery(source: string): MatchmakerQuery {
  const trimmed = source.trim();
  if (trimmed === "" || trimmed === "*") return { source, clauses: [], matchAll: true };
  const clauses: Clause[] = [];
  for (const token of trimmed.split(/\s+/u)) clauses.push(parseToken(token));
  return { source, clauses, matchAll: false };
}

/** 展平属性值：数组要逐个元素参与匹配（上游对数组会为每个元素各建一项）。 */
function flatten(value: PropertyValue): readonly (string | number | boolean)[] {
  if (Array.isArray(value)) return (value as readonly PropertyValue[]).flatMap(flatten);
  return [value as string | number | boolean];
}

function textOf(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "T" : "F";
  return String(value);
}

function matchesTerm(clause: TermClause, values: readonly (string | number | boolean)[]): boolean {
  for (const value of values) {
    if (textOf(value) === clause.value) return true;
    if (typeof value !== "boolean" && clause.value !== "") {
      const numeric = Number(clause.value);
      if (Number.isFinite(numeric) && typeof value === "number" && value === numeric) return true;
    }
  }
  return false;
}

function matchesRange(clause: RangeClause, values: readonly (string | number | boolean)[]): boolean {
  for (const value of values) {
    if (typeof value !== "number") continue;
    switch (clause.op) {
      case ">=":
        if (value >= clause.value) return true;
        break;
      case "<=":
        if (value <= clause.value) return true;
        break;
      case ">":
        if (value > clause.value) return true;
        break;
      default:
        if (value < clause.value) return true;
        break;
    }
  }
  return false;
}

function matchesRegex(clause: RegexClause, values: readonly (string | number | boolean)[]): boolean {
  const anchored = new RegExp(`^(?:${clause.pattern.source})$`);
  for (const value of values) {
    if (anchored.test(textOf(value))) return true;
  }
  return false;
}

function matchesClause(
  clause: Clause,
  fields: ReadonlyMap<string, readonly (string | number | boolean)[]>,
): boolean {
  const values = fields.get(clause.field);
  if (values === undefined) return false;
  switch (clause.kind) {
    case "term":
      return matchesTerm(clause, values);
    case "range":
      return matchesRange(clause, values);
    default:
      return matchesRegex(clause, values);
  }
}

/** 把一份属性（`{a1: "bar"}` 这种）展成"字段路径 → 值序列"。 */
export function propertyFields(
  properties: Readonly<Record<string, PropertyValue>>,
  prefix = "properties.",
): ReadonlyMap<string, readonly (string | number | boolean)[]> {
  const fields = new Map<string, readonly (string | number | boolean)[]>();
  for (const [name, value] of Object.entries(properties)) {
    fields.set(`${prefix}${name}`, flatten(value));
  }
  return fields;
}

export interface QueryMatch {
  readonly matched: boolean;
  /** 命中子句的权重之和；顺序（谁先被选中）由它决定。 */
  readonly score: number;
}

/**
 * 求值。语义与 bluge 的布尔查询一致：
 * 必须子句（`+`）全部命中、禁止子句（`-`）全部不命中、可选子句至少命中一个
 * （若一个可选子句都没有，则"可选"这一维自动为真）。
 */
export function matchFields(
  query: MatchmakerQuery,
  fields: ReadonlyMap<string, readonly (string | number | boolean)[]>,
): QueryMatch {
  if (query.matchAll) return { matched: true, score: 0 };

  let score = 0;
  let optionalHit = false;
  let hasOptional = false;

  for (const clause of query.clauses) {
    const hit = matchesClause(clause, fields);
    if (clause.negative) {
      // 禁止子句命中即整条失败（它的 boost 不参与打分）。
      if (hit) return { matched: false, score: 0 };
      continue;
    }
    if (clause.required) {
      if (!hit) return { matched: false, score: 0 };
      score += clause.boost;
      continue;
    }
    hasOptional = true;
    if (hit) {
      optionalHit = true;
      score += clause.boost;
    }
  }

  if (hasOptional && !optionalHit) return { matched: false, score: 0 };
  return { matched: true, score };
}

/** 便捷入口：直接拿"属性 map"求值。 */
export function matchProperties(
  query: MatchmakerQuery,
  properties: Readonly<Record<string, PropertyValue>>,
  prefix = "properties.",
): QueryMatch {
  return matchFields(query, propertyFields(properties, prefix));
}
