/**
 * 索引声明的存取。
 *
 * 上游把索引配置放在内存（`indexByName` / `indicesByCollection`），启动时重建；
 * 我们把**声明**落在 `storage_indexes` 表里（ECN-0001：每条语句都带 tenant_id），
 * 于是"哪个租户有哪个索引"是库里的显式事实，Worker 换 isolate 也不会丢。
 *
 * 校验的消息逐字照抄上游 `CreateIndex`。
 */

import { Code } from "../../../http/grpc";
import { ApiError } from "../../../http/errors";
import type { StorageEnv } from "../objects/types";
import type { IndexDefinition } from "./types";

interface IndexRow {
  readonly name: string;
  readonly collection: string;
  readonly key: string;
  readonly fields: string;
  readonly sortable_fields: string;
  readonly max_entries: number;
  readonly index_only: number;
}

function parseList(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as string[]) : [];
}

function toDefinition(row: IndexRow): IndexDefinition {
  return {
    name: row.name,
    collection: row.collection,
    key: row.key,
    fields: parseList(row.fields),
    sortableFields: parseList(row.sortable_fields),
    maxEntries: row.max_entries,
    indexOnly: row.index_only === 1,
  };
}

const SELECT_COLUMNS = "name, collection, key, fields, sortable_fields, max_entries, index_only";

export async function createIndex(env: StorageEnv, definition: IndexDefinition): Promise<void> {
  if (definition.name === "") {
    throw new ApiError(Code.InvalidArgument, "storage index 'name' must be set");
  }
  if (definition.collection === "") {
    throw new ApiError(Code.InvalidArgument, "storage index 'collection' must be set");
  }
  if (definition.maxEntries < 1) {
    throw new ApiError(Code.InvalidArgument, "storage Index 'max_entries' must be > 0");
  }
  if (definition.fields.length < 1) {
    throw new ApiError(
      Code.InvalidArgument,
      "storage Index 'fields' must contain at least one top level key to index",
    );
  }

  // 重复名判定交给主键：ON CONFLICT DO NOTHING 让"查重 + 插入"是原子的。
  const result = await env.db
    .prepare(
      `INSERT INTO storage_indexes
         (tenant_id, name, collection, key, fields, sortable_fields, max_entries, index_only)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (tenant_id, name) DO NOTHING`,
    )
    .bind(
      env.tenantId,
      definition.name,
      definition.collection,
      definition.key,
      JSON.stringify(definition.fields),
      JSON.stringify(definition.sortableFields),
      definition.maxEntries,
      definition.indexOnly ? 1 : 0,
    )
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    throw new ApiError(
      Code.AlreadyExists,
      `cannot create index: index with name ${JSON.stringify(definition.name)} already exists`,
    );
  }
}

export async function findIndex(env: StorageEnv, name: string): Promise<IndexDefinition | null> {
  const row = await env.db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM storage_indexes WHERE tenant_id = ?1 AND name = ?2`)
    .bind(env.tenantId, name)
    .first<IndexRow>();
  return row === null ? null : toDefinition(row);
}

/** 上游 `GetIndexes`：按 name 升序返回全部索引声明。 */
export async function listIndexes(env: StorageEnv): Promise<IndexDefinition[]> {
  const result = await env.db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM storage_indexes WHERE tenant_id = ?1 ORDER BY name ASC`)
    .bind(env.tenantId)
    .all<IndexRow>();
  return (result.results ?? []).map(toDefinition);
}
