/**
 * 列举对象。
 *
 * 五条路径与上游 `server/core_storage.go::StorageListObjects` 一一对应：
 *   1. 不过滤所有者 + 运行时：不受读权限限制，按 (read_perm, key, user_id) 升序；
 *   2. 不过滤所有者 + 客户端：只列公共可读（`read_perm >= 2`），按 (read_perm, key, user_id) 升序；
 *   3. 列自己（`ownerId === callerId`）：`read_perm >= 1`，按 (read_perm, key) 升序；
 *   4. 列别人：只列公共可读（`read_perm = 2`），按 key 升序；
 *   5. 列别人 + 运行时：不受读权限限制，按 (read_perm, key) 升序。
 *
 * 排序里出现 `read_perm` 而不是按时间，是上游的真实行为，不是笔误。
 */

import { decodeCursor, encodeCursor } from "../cursor";
import { OBJECT_COLUMNS } from "./sql";
import {
  NIL_USER_ID,
  type ListOptions,
  type ListResult,
  type StorageEnv,
  type StorageObjectRow,
} from "./types";

interface Plan {
  readonly where: string;
  readonly orderBy: string;
  readonly cursorPredicate: string;
}

function planFor(callerId: string, authoritative: boolean, ownerId: string | null): Plan {
  if (ownerId === null) {
    if (authoritative) {
      return {
        where: "tenant_id = ?1 AND collection = ?2",
        orderBy: "read_perm ASC, key ASC, user_id ASC",
        cursorPredicate: "(read_perm, key, user_id) > (?3, ?4, ?5)",
      };
    }
    return {
      where: "tenant_id = ?1 AND collection = ?2 AND read_perm >= 2",
      orderBy: "read_perm ASC, key ASC, user_id ASC",
      cursorPredicate: "(read_perm, key, user_id) > (2, ?3, ?4)",
    };
  }
  if (ownerId === callerId && !authoritative) {
    return {
      where: "tenant_id = ?1 AND collection = ?2 AND user_id = ?3 AND read_perm >= 1",
      orderBy: "read_perm ASC, key ASC",
      cursorPredicate: "(read_perm, key) > (?4, ?5)",
    };
  }
  if (ownerId === callerId || authoritative) {
    return {
      where: "tenant_id = ?1 AND collection = ?2 AND user_id = ?3",
      orderBy: "read_perm ASC, key ASC",
      cursorPredicate: "(read_perm, key) > (?4, ?5)",
    };
  }
  return {
    where: "tenant_id = ?1 AND collection = ?2 AND user_id = ?3 AND read_perm = 2",
    orderBy: "key ASC",
    cursorPredicate: "key > ?4",
  };
}

export async function listObjects(
  env: StorageEnv,
  callerId: string,
  options: ListOptions,
): Promise<ListResult> {
  // 运行时路径（调用者是全零 UUID）不受读权限限制；上游 `StorageListObjects` 的
  // `if caller == uuid.Nil { … true … }` 分支与此一一对应。
  const authoritative = options.authoritative === true || callerId === NIL_USER_ID;
  const limit = options.limit;
  const decoding = options.cursor === "" ? null : decodeCursor(options.cursor);
  const plan = planFor(callerId, authoritative, options.ownerId);

  let params: unknown[];
  if (decoding === null) {
    params =
      options.ownerId === null
        ? [env.tenantId, options.collection, limit + 1]
        : [env.tenantId, options.collection, options.ownerId, limit + 1];
  } else if (options.ownerId === null) {
    params = authoritative
      ? [env.tenantId, options.collection, decoding.read, decoding.key, decoding.userId, limit + 1]
      : [env.tenantId, options.collection, decoding.key, decoding.userId, limit + 1];
  } else if (options.ownerId === callerId || authoritative) {
    params = [env.tenantId, options.collection, options.ownerId, decoding.read, decoding.key, limit + 1];
  } else {
    params = [env.tenantId, options.collection, options.ownerId, decoding.key, limit + 1];
  }

  const sql =
    `SELECT ${OBJECT_COLUMNS} FROM storage_objects WHERE ${plan.where}` +
    (decoding === null ? "" : ` AND ${plan.cursorPredicate}`) +
    ` ORDER BY ${plan.orderBy} LIMIT ?${params.length}`;

  const result = await env.db
    .prepare(sql)
    .bind(...params)
    .all<StorageObjectRow>();
  const rows = result.results ?? [];

  const objects = rows.slice(0, limit);
  let nextCursor = "";
  if (rows.length > limit) {
    const last = objects[objects.length - 1];
    if (last !== undefined) {
      nextCursor = encodeCursor({ read: last.read_perm, key: last.key, userId: last.user_id });
    }
  }
  // 反向不变量：算出来的游标与请求里的一样 → 说明没有前进，返回空游标（上游同款保护）。
  if (nextCursor !== "" && nextCursor === options.cursor) nextCursor = "";

  return { objects, cursor: nextCursor };
}
