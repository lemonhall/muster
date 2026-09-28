/**
 * 存储引擎的 SQL 片段与语句构造。
 *
 * 所有语句都显式带 `tenant_id` 谓词（ECN-0001：没有"默认租户"回退），参数一律用
 * `?N` 编号占位符，而不是 `?`——因为守卫语句要把同样的参数再绑一遍，编号占位符
 * 才能让"同一批语句共用一份参数"不串位。
 */

import { md5Hex } from "../md5";
import type { StorageEnv, StorageObjectRow, WriteOp } from "./types";

export type PreparedStatement = ReturnType<D1Database["prepare"]>;

/** 写权限谓词：客户端写入必须尊重既有对象的 write 位；运行时（authoritative）跳过。 */
export function writePermissionSql(authoritative: boolean): string {
  return authoritative ? "1 = 1" : "storage_objects.write_perm = 1";
}

export function guardStatement(
  env: StorageEnv,
  condition: string,
  params: readonly unknown[],
): PreparedStatement {
  // 条件是"业务前置条件成立"。成立 → ok=1（无害）；不成立 → CHECK 失败 → 整批回滚。
  return env.db
    .prepare(
      `INSERT INTO storage_batch_guard (id, ok) VALUES (1, CASE WHEN ${condition} THEN 1 ELSE 0 END)
       ON CONFLICT (id) DO UPDATE SET ok = excluded.ok`,
    )
    .bind(...params);
}

/** "存在且可写"：非运行时写入必须尊重既有对象的 write 位。 */
export function writableObjectExistsSql(authoritative: boolean): string {
  return (
    "EXISTS (SELECT 1 FROM storage_objects WHERE tenant_id = ?1 AND collection = ?2 AND key = ?3 AND user_id = ?4" +
    (authoritative ? ")" : " AND storage_objects.write_perm = 1)")
  );
}

/** "存在"：只用于 `version = "*"`（只许新建）这一条路径。 */
export const OBJECT_EXISTS_SQL =
  "EXISTS (SELECT 1 FROM storage_objects WHERE tenant_id = ?1 AND collection = ?2 AND key = ?3 AND user_id = ?4)";

/** "存在且版本与期望一致"：OCC 写入的守卫（非运行时额外要求既有对象可写）。 */
export function versionMatchSql(authoritative: boolean): string {
  return (
    "EXISTS (SELECT 1 FROM storage_objects WHERE tenant_id = ?1 AND collection = ?2 AND key = ?3" +
    " AND user_id = ?4 AND version = ?5" +
    (authoritative ? ")" : " AND write_perm = 1)")
  );
}

function upsertStatement(
  env: StorageEnv,
  ownerId: string,
  op: WriteOp,
  authoritative: boolean,
): PreparedStatement {
  return env.db
    .prepare(
      `INSERT INTO storage_objects
         (tenant_id, collection, key, user_id, value, version, read_perm, write_perm, create_time, update_time)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
       ON CONFLICT (tenant_id, collection, key, user_id) DO UPDATE SET
         value = excluded.value,
         version = excluded.version,
         read_perm = excluded.read_perm,
         write_perm = excluded.write_perm,
         update_time = excluded.update_time
       WHERE ${writePermissionSql(authoritative)}
         AND NOT (storage_objects.version = excluded.version
                  AND storage_objects.read_perm = excluded.read_perm
                  AND storage_objects.write_perm = excluded.write_perm)
       RETURNING collection, key, user_id, value, version, read_perm, write_perm, create_time, update_time`,
    )
    .bind(
      env.tenantId,
      op.collection,
      op.key,
      ownerId,
      op.value,
      md5Hex(op.value),
      op.permissionRead,
      op.permissionWrite,
      env.nowSec,
    );
}

function insertOnlyStatement(env: StorageEnv, ownerId: string, op: WriteOp): PreparedStatement {
  return env.db
    .prepare(
      `INSERT INTO storage_objects
         (tenant_id, collection, key, user_id, value, version, read_perm, write_perm, create_time, update_time)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
       ON CONFLICT (tenant_id, collection, key, user_id) DO NOTHING
       RETURNING collection, key, user_id, value, version, read_perm, write_perm, create_time, update_time`,
    )
    .bind(
      env.tenantId,
      op.collection,
      op.key,
      ownerId,
      op.value,
      md5Hex(op.value),
      op.permissionRead,
      op.permissionWrite,
      env.nowSec,
    );
}

function occStatement(
  env: StorageEnv,
  ownerId: string,
  op: WriteOp,
  authoritative: boolean,
): PreparedStatement {
  return env.db
    .prepare(
      `UPDATE storage_objects
         SET value = ?5, version = ?6, read_perm = ?7, write_perm = ?8, update_time = ?9
       WHERE tenant_id = ?1 AND collection = ?2 AND key = ?3 AND user_id = ?4
         AND version = ?10 AND ${writePermissionSql(authoritative)}
       RETURNING collection, key, user_id, value, version, read_perm, write_perm, create_time, update_time`,
    )
    .bind(
      env.tenantId,
      op.collection,
      op.key,
      ownerId,
      op.value,
      md5Hex(op.value),
      op.permissionRead,
      op.permissionWrite,
      env.nowSec,
      op.version,
    );
}

/**
 * 依 `op.version` 的三态选一条写入语句：
 * `""` → upsert（无条件覆盖，但仍要过写权限）；`"*"` → insert-only；其余 → OCC 更新。
 */
export function writeStatement(
  env: StorageEnv,
  ownerId: string,
  op: WriteOp,
  authoritative: boolean,
): PreparedStatement {
  if (op.version === "") return upsertStatement(env, ownerId, op, authoritative);
  if (op.version === "*") return insertOnlyStatement(env, ownerId, op);
  return occStatement(env, ownerId, op, authoritative);
}

export const OBJECT_COLUMNS =
  "collection, key, user_id, value, version, read_perm, write_perm, create_time, update_time";

/** 批内排序键：上游 `indexedOps` 先把同一个 (collection, key, owner) 的写排到一起，保证批内顺序可预期。 */
export function sortKey(op: WriteOp, ownerId: string): string {
  return `${op.collection}\u0000${op.key}\u0000${ownerId}`;
}

export async function findObject(
  env: StorageEnv,
  ownerId: string,
  collection: string,
  key: string,
): Promise<StorageObjectRow | null> {
  return env.db
    .prepare(
      `SELECT ${OBJECT_COLUMNS} FROM storage_objects` +
        " WHERE tenant_id = ?1 AND collection = ?2 AND key = ?3 AND user_id = ?4",
    )
    .bind(env.tenantId, collection, key, ownerId)
    .first<StorageObjectRow>();
}
