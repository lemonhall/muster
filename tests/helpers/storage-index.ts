/**
 * 存储索引契约测试的公共工装。
 *
 * 与 `storage-domain.ts` 同一套思路：把"建索引 / 写对象 / 查索引 / 拆场"重复的部分
 * 收在这里，让每个测试文件只留与被测行为有关的断言。
 *
 * 上游 `storage_index_test.go` 里所有写入都带 `authoritative = true`
 * （运行时写入：跳过写权限位检查），这里用 `writeAt` 固定住这件事。
 */

import { createIndex, listIndex, listIndexes } from "../../src/domain/storage/index";
import type { IndexDefinition, IndexListResult } from "../../src/domain/storage/index";
import { NIL_USER_ID, deleteObjects, writeObjects } from "../../src/domain/storage/objects";
import type { DeleteOp, StorageEnv, WriteOp } from "../../src/domain/storage/objects";
import { generateString, insertUser, newUserId, storageEnv } from "./storage";
import { op } from "./storage-domain";

/** 索引测试用自己的租户 id，与存储测试的租户互不打扰。 */
export const INDEX_TENANT = "EEEEEEEE-0000-4000-8000-0000000000EE";

export { NIL_USER_ID, createIndex, deleteObjects, generateString, insertUser, listIndexes, newUserId, op, writeObjects };
export type { DeleteOp, IndexDefinition, IndexListResult, StorageEnv, WriteOp };

export function indexEnv(nowSec = 1_700_000_000): StorageEnv {
  return storageEnv(INDEX_TENANT, nowSec);
}

/** 建索引的短写法（参数顺序照上游 `CreateIndex`）。 */
export async function createIndexFor(
  env: StorageEnv,
  name: string,
  collection: string,
  key: string,
  fields: readonly string[],
  sortableFields: readonly string[],
  maxEntries: number,
  indexOnly: boolean,
): Promise<void> {
  await createIndex(env, { name, collection, key, fields, sortableFields, maxEntries, indexOnly });
}

/** 运行时写入（authoritative）：上游索引测试里每一次 `StorageWriteObjects(...)` 都是这个形状。 */
export async function writeAt(env: StorageEnv, ownerId: string, ops: readonly WriteOp[]): Promise<void> {
  await writeObjects(env, ownerId, ops, { authoritative: true });
}

/** 运行时删除：同上。 */
export async function deleteAt(env: StorageEnv, ownerId: string, ops: readonly DeleteOp[]): Promise<void> {
  await deleteObjects(env, ownerId, ops, { authoritative: true });
}

/** 查索引（参数顺序照上游 `List`）。 */
export function readIndex(
  env: StorageEnv,
  callerId: string,
  indexName: string,
  query: string,
  limit: number,
  order: readonly string[] = [],
  cursor = "",
): Promise<IndexListResult> {
  return listIndex(env, callerId, { indexName, query, limit, order, cursor });
}

/** 上游测试里的 `json.Marshal(map[string]any{...})` 结果（键名升序，与 Go 一致）。 */
export function jsonValue(source: Record<string, unknown>): string {
  const keys = Object.keys(source).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(source[key])}`).join(",")}}`;
}

/** 拆场：把写过的东西删干净，避免用例之间互相看见。 */
export function teardown(env: StorageEnv, ops: readonly { readonly ownerId: string; readonly collection: string; readonly key: string }[]): Promise<void> {
  let chain = Promise.resolve();
  for (const op of ops) {
    chain = chain.then(() =>
      deleteAt(env, op.ownerId, [{ collection: op.collection, key: op.key, version: "" }]),
    );
  }
  return chain;
}
