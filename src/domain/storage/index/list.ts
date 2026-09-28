/**
 * 索引列表（上游 `LocalStorageIndex.List`）。
 *
 * 与上游的**机制差异**（ECN-0005）：上游维护一份内存 bluge 索引，写入时同步喂进去，
 * 重启后从库里重建；我们把索引编译成对权威表 `storage_objects` 的声明式查询。
 * 于是：
 *   - 索引与权威数据**不可能不一致**，上游那套"回查发现版本不符就重索引"在这里是空操作；
 *   - 淘汰不再发生在写入时，而是在查询时等价地生效：索引里超过 `maxEntries * 1.1` 条时，
 *     只保留最新的 `maxEntries` 条（顺序 = `update_time DESC, user_id DESC, key DESC`）。
 *     `update_time` 在本项目是秒级，同一秒内的写入靠 user_id/key 决胜——这是本项目
 *     唯一无法逐位复刻的地方（上游是微秒级时间戳），见 ECN-0005。
 *
 * 可观测语义逐条对齐：查询串语义、`+` 必须子句、权限过滤、分页游标、index_only 投影、
 * 缺索引报 `not found`、游标四元组不符报 `invalid`。
 */

import { Code } from "../../../http/grpc";
import { ApiError } from "../../../http/errors";
import { OBJECT_COLUMNS } from "../objects/sql";
import { NIL_USER_ID, type StorageEnv, type StorageObjectRow } from "../objects/types";
import { assertCursorMatches, decodeIndexCursor, encodeIndexCursor } from "./cursor";
import { projectValue } from "./project";
import { matchFragment, membershipFragment, orderFragment, parseIndexQuery, type SqlFragment } from "./query";
import { findIndex } from "./store";
import type { IndexListOptions, IndexListResult } from "./types";

/**
 * 上游的淘汰触发线：`count > uint64(float32(maxEntries) * 1.1)`。
 *
 * `Math.fround` 复刻 float32 乘法，`Math.trunc` 复刻 Go 把浮点转 uint64 的截断——
 * 少一样，maxEntries=10 时阈值就会从 11 变成 11.000000238（永不触发）。
 */
export function evictionThreshold(maxEntries: number): number {
  return Math.trunc(Math.fround(Math.fround(maxEntries) * Math.fround(1.1)));
}

async function countIndexMembers(env: StorageEnv, membership: SqlFragment): Promise<number> {
  const row = await env.db
    .prepare(`SELECT COUNT(*) AS total FROM storage_objects WHERE ${membership.sql}`)
    .bind(...membership.params)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function listIndex(
  env: StorageEnv,
  callerId: string,
  options: IndexListOptions,
): Promise<IndexListResult> {
  const definition = await findIndex(env, options.indexName);
  if (definition === null) {
    // 上游：`index %q: %w` 包 ErrNotFound。
    throw new ApiError(Code.NotFound, `index ${JSON.stringify(options.indexName)}: not found`);
  }
  // limit > maxEntries 只有一条 warn（上游第 260 行），不影响结果——所以这里什么都不做。

  const query = options.query === "" ? "*" : options.query;
  const limit = options.limit;
  const order = [...options.order];
  const decoded = options.cursor === "" ? null : decodeIndexCursor(options.cursor);
  const offset = decoded === null ? 0 : decoded.offset;
  if (decoded !== null) assertCursorMatches(decoded, { query, offset, limit, order });

  const clauses = parseIndexQuery(query);
  const membership = membershipFragment(env.tenantId, definition);
  const match = matchFragment(clauses, definition.fields);
  const orderBy = orderFragment(order, definition);
  // 调用者是 nil user 时不做读权限过滤（与读对象、列举对象同一条规则）。
  const authoritative = callerId === NIL_USER_ID;

  const total = await countIndexMembers(env, membership);
  const capped = total > evictionThreshold(definition.maxEntries);

  const where: string[] = [membership.sql];
  const params: unknown[] = [...membership.params];
  if (capped) {
    where.push(
      "(storage_objects.update_time, storage_objects.user_id, storage_objects.key) IN (" +
        `SELECT update_time, user_id, key FROM storage_objects WHERE ${membership.sql}` +
        " ORDER BY update_time DESC, user_id DESC, key DESC LIMIT ?)",
    );
    params.push(...membership.params, definition.maxEntries);
  }
  where.push(match.sql);
  params.push(...match.params);
  if (!authoritative) {
    where.push(
      "(storage_objects.read_perm = 2" +
        " OR (storage_objects.read_perm = 1 AND storage_objects.user_id = ?))",
    );
    params.push(callerId);
  }
  params.push(limit + 1, offset);

  const sql =
    `SELECT ${OBJECT_COLUMNS} FROM storage_objects WHERE ${where.join(" AND ")}` +
    ` ORDER BY ${orderBy.sql} LIMIT ? OFFSET ?`;

  const result = await env.db
    .prepare(sql)
    .bind(...params)
    .all<StorageObjectRow>();
  const rows = result.results ?? [];
  const objects = rows.slice(0, limit);
  let nextCursor = "";
  if (rows.length > limit) {
    nextCursor = encodeIndexCursor({ query, offset: offset + limit, limit, order });
  }
  if (objects.length === 0) return { objects: [], cursor: "" };

  if (!definition.indexOnly) {
    // 上游这里会拿着索引命中再去权威表读一遍并按索引顺序重排。我们的查询本来就打在
    // 权威表上，读到的就是权威值，顺序也已经是索引顺序——所以这一步无事可做。
    return { objects, cursor: nextCursor };
  }

  const projected = objects.map((row) => ({
    ...row,
    value: projectValue(row.value, definition.fields) ?? row.value,
  }));
  return { objects: projected, cursor: nextCursor };
}
