/**
 * 存储索引的类型。
 *
 * 上游 `server/storage_index.go` 的 `StorageIndexConfig` / `indexListCursor` 在这里
 * 各有一个等价物，字段名保持同义，方便逐条对照。
 */

import type { StorageObjectRow } from "../objects/types";

/** 一条索引声明（上游 `StorageIndexConfig`）。 */
export interface IndexDefinition {
  readonly name: string;
  readonly collection: string;
  /** 空串 = 该集合内所有 key 都进这个索引（上游 `Key == ""`）。 */
  readonly key: string;
  /** 索引哪些顶层字段。只有这里列出的字段可被查询命中（上游 `Fields`）。 */
  readonly fields: readonly string[];
  /** 可排序字段（上游 `SortableFields`）。 */
  readonly sortableFields: readonly string[];
  /** 容量上限（上游 `MaxEntries`）。 */
  readonly maxEntries: number;
  /** 只返回索引里的值副本，不回查权威表（上游 `IndexOnly`）。 */
  readonly indexOnly: boolean;
}

export interface IndexListOptions {
  readonly indexName: string;
  /** 上游 `List` 的 query：空串等价于 `*`。 */
  readonly query: string;
  readonly limit: number;
  readonly order: readonly string[];
  readonly cursor: string;
}

/** `objects` 里 indexOnly 路径的 `value` 是**投影后的** JSON，与上游一致。 */
export interface IndexListResult {
  readonly objects: StorageObjectRow[];
  readonly cursor: string;
}

/** 上游 `indexListCursor`：查询/偏移/条数/排序四元组。 */
export interface IndexCursor {
  readonly query: string;
  readonly offset: number;
  readonly limit: number;
  readonly order: readonly string[];
}
