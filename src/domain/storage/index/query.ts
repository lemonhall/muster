/**
 * 查询串 → SQL 谓词。
 *
 * 上游的索引是 bluge 全文索引，查询串走 `ParseQueryString`（keyword 分析器）。
 * 我们只实现**存储索引实际用到的那一小撮语法**，并把它的语义逐条对齐：
 *
 * - `*` 或空串 → 匹配全部；
 * - 空格分隔的子句默认是 **OR**（不是 AND！上游 `List` 的"分页"用例就是这个语义：
 *   `value.one:1 value.two:2 value.three:3` 在三个各只有一个字段的对象上返回 3 条）；
 * - `+value.f:v` → 该子句是**必须**（Lucene/bluge 的 `+` 前缀）；
 * - 值 `T` / `F` 对应 JSON 布尔（上游把 bool 索引成关键字 "T"/"F"）；
 * - 没写进索引 `fields` 的字段**在索引里根本不存在**，所以引用它的子句恒不匹配
 *   （这里编译成 `1 = 0`，而不是把子句删掉——删掉会改变 OR 结构）。
 *
 * 未实现的语法（短语引号、范围、通配符）会在解析时报错，而不是悄悄当成别的语义。
 */

import { Code } from "../../../http/grpc";
import { ApiError } from "../../../http/errors";
import type { IndexDefinition } from "./types";

export interface QueryClause {
  readonly field: string;
  readonly value: string;
  /** `+` 前缀 = 必须有（bluge/Lucene 的 must）。 */
  readonly required: boolean;
}

export interface SqlFragment {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function badQuery(reason: string): ApiError {
  // 上游：`failed to parse query string: <err>: invalid`
  return new ApiError(Code.InvalidArgument, `failed to parse query string: ${reason}: invalid`);
}

function isIdentifier(name: string): boolean {
  return /^[A-Za-z0-9_]+$/u.test(name);
}

export function parseIndexQuery(query: string): QueryClause[] {
  const trimmed = query.trim();
  if (trimmed === "" || trimmed === "*") return [];

  const clauses: QueryClause[] = [];
  for (const token of trimmed.split(/\s+/u)) {
    let body = token;
    let required = false;
    if (body.startsWith("+")) {
      required = true;
      body = body.slice(1);
    } else if (body.startsWith("-")) {
      // must-not 不是存储索引的既有用法；明说没实现，好过默默按"必须"处理。
      throw badQuery("negation is not supported");
    }
    const separator = body.indexOf(":");
    if (!body.startsWith("value.") || separator < 0) {
      throw badQuery(`unsupported clause ${JSON.stringify(token)}`);
    }
    const field = body.slice("value.".length, separator);
    const value = body.slice(separator + 1);
    if (!isIdentifier(field)) throw badQuery(`unsupported field ${JSON.stringify(field)}`);
    if (value === "") throw badQuery("empty term");
    clauses.push({ field, value, required });
  }
  return clauses;
}

/**
 * 单条子句的匹配谓词。
 *
 * `json_each` 而不是 `json_extract`：上游对数组会为每个元素各建一个字段，所以
 * "任一元素相等"才是等价语义。
 */
function clauseFragment(clause: QueryClause, indexedFields: readonly string[]): SqlFragment {
  if (!indexedFields.includes(clause.field)) {
    // 索引里没有这个字段 → 恒不匹配（但保留布尔结构）。
    return { sql: "1 = 0", params: [] };
  }
  const path = `$.${clause.field}`;
  const params: unknown[] = [path, clause.value, clause.value, clause.value];
  return {
    sql:
      "(EXISTS (SELECT 1 FROM json_each(storage_objects.value, ?) AS _je WHERE " +
      "(_je.type IN ('text', 'integer', 'real') AND CAST(_je.value AS TEXT) = ?) " +
      "OR (? = 'T' AND _je.type = 'true') " +
      "OR (? = 'F' AND _je.type = 'false')))",
    params,
  };
}

/**
 * 把子句集合编译成"必须 AND（可选 OR）"的谓词——与 bluge 布尔查询的
 * must / should 组合一致：`a b` → `a OR b`；`a +b` → 必须有 b、a 可选。
 */
export function matchFragment(
  clauses: readonly QueryClause[],
  indexedFields: readonly string[],
): SqlFragment {
  const required = clauses.filter((clause) => clause.required);
  const optional = clauses.filter((clause) => !clause.required);
  const params: unknown[] = [];
  const parts: string[] = [];

  for (const clause of required) {
    const fragment = clauseFragment(clause, indexedFields);
    parts.push(fragment.sql);
    params.push(...fragment.params);
  }
  if (optional.length > 0) {
    const orParts: string[] = [];
    for (const clause of optional) {
      const fragment = clauseFragment(clause, indexedFields);
      orParts.push(fragment.sql);
      params.push(...fragment.params);
    }
    parts.push(`(${orParts.join(" OR ")})`);
  }
  if (parts.length === 0) return { sql: "1 = 1", params: [] };
  return { sql: `(${parts.join(" AND ")})`, params };
}

/** 索引的"成员资格"谓词：集合 + key 过滤 + 至少有一个被索引字段存在。 */
export function membershipFragment(
  tenantId: string,
  definition: IndexDefinition,
): SqlFragment {
  const params: unknown[] = [tenantId, definition.collection];
  let sql = "storage_objects.tenant_id = ? AND storage_objects.collection = ?";
  if (definition.key !== "") {
    sql += " AND storage_objects.key = ?";
    params.push(definition.key);
  }
  const placeholders = definition.fields.map(() => "?").join(", ");
  params.push(...definition.fields);
  // 字段**存在**即算进索引（哪怕值是 JSON null）：上游只按 mapValue 是否为空判定，
  // null 也算"存在"，只是不会产生 value.* 字段。
  sql +=
    " AND EXISTS (SELECT 1 FROM json_each(storage_objects.value) AS _m" +
    ` WHERE _m.key IN (${placeholders}))`;
  return { sql, params };
}

const PLAIN_SORT_FIELDS: Readonly<Record<string, string>> = {
  collection: "storage_objects.collection",
  key: "storage_objects.key",
  user_id: "storage_objects.user_id",
  version: "storage_objects.version",
  read: "storage_objects.read_perm",
  write: "storage_objects.write_perm",
  create_time: "storage_objects.create_time",
  update_time: "storage_objects.update_time",
};

/**
 * 一个排序字段展开成若干条 SQL 表达式。
 *
 * `value.*` 要占三段：先按"是不是数值"分组，再按数值排，最后按文本排——所以调用方必须
 * **逐段**加 ASC/DESC，只给最后一段加方向会让降序静默退化成升序。
 */
function sortExpressionsForField(field: string, definition: IndexDefinition): string[] {
  const plain = PLAIN_SORT_FIELDS[field];
  if (plain !== undefined) return [plain];
  if (!field.startsWith("value.")) {
    throw new ApiError(Code.InvalidArgument, `failed to sort by field ${field}: invalid`);
  }
  const name = field.slice("value.".length);
  if (!definition.sortableFields.includes(name)) {
    // 没声明 sortable 的字段在索引里没有排序值（上游要报错，而不是当成 0）。
    throw new ApiError(Code.InvalidArgument, `failed to sort by field ${field}: invalid`);
  }
  const path = `$.${name}`;
  return [
    `(CASE WHEN json_type(storage_objects.value, '${path}') IN ('integer', 'real') THEN 0 ELSE 1 END)`,
    `CAST(json_extract(storage_objects.value, '${path}') AS REAL)`,
    `CAST(json_extract(storage_objects.value, '${path}') AS TEXT)`,
  ];
}

/**
 * ORDER BY 子句。默认排序用 (collection, key, user_id)——等价于上游 bluge 文档 id
 * `collection.key.user_id` 的字典序，而那正是 bluge 在打分相同时的稳定顺序。
 * 结尾**总是**补上默认排序做决胜，保证分页不会漏条或重复。
 */
export function orderFragment(
  order: readonly string[],
  definition: IndexDefinition,
): SqlFragment {
  const parts: string[] = [];
  for (const entry of order) {
    const descending = entry.startsWith("-");
    const field = descending ? entry.slice(1) : entry;
    if (field === "") throw new ApiError(Code.InvalidArgument, "failed to sort by field: invalid");
    const direction = descending ? "DESC" : "ASC";
    for (const expression of sortExpressionsForField(field, definition)) {
      parts.push(`${expression} ${direction}`);
    }
  }
  parts.push("storage_objects.collection ASC", "storage_objects.key ASC", "storage_objects.user_id ASC");
  return { sql: parts.join(", "), params: [] };
}
