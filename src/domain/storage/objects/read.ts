/**
 * 批量读对象。
 *
 * 客户端（非运行时）能看到的对象只有两类：`read_perm = 2`（公共可读）与
 * `read_perm = 1` 且属于自己。`read_perm = 0` 的对象连属主都不给 —— 这是上游
 * SQL 里 `(read = 2 or (read = 1 and storage.user_id = $4))` 的字面语义。
 *
 * 请求里重复的 (collection, key, user_id) 只会返回一次（上游靠 SQL 的自然连接去重）。
 *
 * 调用者是全零 UUID 时**不加任何读权限条件**：上游那一句
 * `if caller != uuid.Nil { query += "(read = 2 or ...)" }` 就是这个意思——
 * 运行时（Lua/JS/Go 扩展）读得到任何对象，客户端读不到别人的私有对象。
 */

import { OBJECT_COLUMNS } from "./sql";
import {
  NIL_USER_ID,
  type ReadObjectId,
  type StorageEnv,
  type StorageObjectRow,
} from "./types";

export async function readObjects(
  env: StorageEnv,
  callerId: string,
  ids: readonly ReadObjectId[],
  options: { readonly authoritative?: boolean } = {},
): Promise<StorageObjectRow[]> {
  const authoritative = options.authoritative === true || callerId === NIL_USER_ID;
  const seen = new Set<string>();
  const unique: ReadObjectId[] = [];
  for (const id of ids) {
    // 上游把 `user_id` 解析成 `uuid.UUID`，空串就是 nil（全局对象）——这一步必须在
    // 领域层完成，否则 HTTP 层漏掉一次规范化就会读不到别人的全局对象。
    const userId = id.userId === "" ? NIL_USER_ID : id.userId;
    const dedupeKey = `${id.collection}\u0000${id.key}\u0000${userId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    unique.push({ collection: id.collection, key: id.key, userId });
  }
  if (unique.length === 0) return [];

  const permission = authoritative ? "" : " AND (read_perm = 2 OR (read_perm = 1 AND user_id = ?5))";
  const statements = unique.map((id) =>
    env.db
      .prepare(
        `SELECT ${OBJECT_COLUMNS} FROM storage_objects` +
          " WHERE tenant_id = ?1 AND collection = ?2 AND key = ?3 AND user_id = ?4" +
          permission,
      )
      .bind(
        // 运行时读路径里 SQL 不出现 ?5，多绑一个参数 D1 会直接报错——按分支绑。
        ...(authoritative
          ? [env.tenantId, id.collection, id.key, id.userId]
          : [env.tenantId, id.collection, id.key, id.userId, callerId]),
      ),
  );

  const results = await env.db.batch<StorageObjectRow>(statements);
  const rows: StorageObjectRow[] = [];
  for (const result of results) {
    for (const row of result.results ?? []) rows.push(row);
  }
  // 确定性输出：上游对多参数查询没有承诺顺序，但测试与客户端都更希望结果稳定。
  rows.sort((left, right) => {
    const a = `${left.collection}\u0000${left.key}\u0000${left.user_id}`;
    const b = `${right.collection}\u0000${right.key}\u0000${right.user_id}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return rows;
}
