import { Code } from "../../http/grpc";
import { ApiError, internal } from "../../http/errors";
import { decodeCursor, encodeCursor } from "./cursor";
import { md5Hex } from "./md5";

/**
 * 存储引擎的领域逻辑。
 *
 * 全部语义逐条取自上游 `server/core_storage.go`（写入的三种版本模式、权限判定、
 * 批量原子性、列表排序与游标），**包括它反直觉的地方**：
 *
 * - `version = ""` → 无条件覆盖（last write wins），但仍要过写权限；
 * - `version = "*"` → 只允许新建（对象已存在即拒绝）；
 * - `version = <md5>` → 乐观锁，版本不符即拒绝；
 * - 拒绝时的错误码与消息是三选一，由"权限"和"版本"哪个先成立决定（见 disambiguate）；
 * - 列表排序按 `read_perm` 升序再按 `key`（不是按时间、也不是按 key 单独排）。
 *
 * 多租户（ECN-0001）：每一条语句都带 `tenant_id`，没有"默认租户"回退。
 *
 * **批量原子性怎么做到的**：D1 的 `batch()` 是单事务（任一语句失败即整体回滚），但它
 * 不会因为"条件不满足、影响 0 行"而失败。所以每一步先放一条**守卫语句**：把业务前置条件
 * 写成 `CHECK (ok = 1)` 约束下的插入，条件不成立就让整批失败回滚；条件成立时守卫行在
 * 同一批的末尾被删掉，表始终是空的。这样"要么全成功要么全失败"就落在数据库事务上，
 * 而不是靠应用层的自觉。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_storage.go::StorageWriteObjects
 * 契约源: server/core_storage.go::storagePrepBatch
 * 契约源: server/core_storage.go::storageWriteObjects
 * 契约源: server/core_storage.go::StorageReadObjects
 * 契约源: server/core_storage.go::StorageListObjects
 * 契约源: server/core_storage.go::StorageDeleteObjects
 * 契约源: server/core_storage.go::storageDeleteObjects
 * 契约源: server/core_storage.go::storageListObjects
 * 契约源: server/api_storage.go::ReadStorageObjects
 * 契约源: server/api_storage.go::WriteStorageObjects
 * 契约源: server/api_storage.go::DeleteStorageObjects
 * 契约源: server/api_storage.go::ListStorageObjects
 */

export interface StorageEnv {
  readonly db: D1Database;
  readonly tenantId: string;
  readonly nowSec: number;
}

/** 上游 `runtime.ErrStorageRejectedVersion` / `ErrStorageRejectedPermission` 的等价物。 */
export const VERSION_REJECTED_MESSAGE = "Storage write rejected - version check failed.";
export const PERMISSION_REJECTED_MESSAGE = "Storage write rejected - permission denied.";
export const DELETE_REJECTED_MESSAGE =
  "Storage delete rejected - not found, version check failed, or permission denied.";

export const READ_PRIVATE = 0;
export const READ_OWNER = 1;
export const READ_PUBLIC = 2;

/**
 * 上游的 `uuid.Nil`：全零 UUID。
 *
 * 它的含义是"系统/全局对象"——`StorageWriteWithRetries` 在 `write.UserID == ""` 时
 * 就把所有者写成它，运行时（Lua/JS/Go 扩展）写世界共享数据走的就是这条路。
 * 客户端的 REST 写入永远以调用者自己为所有者，所以这个值只会出现在运行时路径与
 * 客户端读全局对象时的 `user_id` 缺省上。
 */
export const NIL_USER_ID = "00000000-0000-0000-0000-000000000000";

export interface StorageObjectRow {
  readonly collection: string;
  readonly key: string;
  readonly user_id: string;
  readonly value: string;
  readonly version: string;
  readonly read_perm: number;
  readonly write_perm: number;
  readonly create_time: number;
  readonly update_time: number;
}

export interface WriteOp {
  readonly collection: string;
  readonly key: string;
  readonly value: string;
  /** `""`（无条件）、`"*"`（必须不存在）或一个期望的版本哈希。 */
  readonly version: string;
  readonly permissionRead: number;
  readonly permissionWrite: number;
}

export interface Ack {
  readonly collection: string;
  readonly key: string;
  readonly version: string;
  readonly userId: string;
  readonly createTime: number;
  readonly updateTime: number;
}

type PreparedStatement = ReturnType<D1Database["prepare"]>;

/** 写权限谓词：客户端写入必须尊重既有对象的 write 位；运行时（authoritative）跳过。 */
function writePermissionSql(authoritative: boolean): string {
  return authoritative ? "1 = 1" : "storage_objects.write_perm = 1";
}

function guardStatement(env: StorageEnv, condition: string, params: readonly unknown[]): PreparedStatement {
  // 条件是"业务前置条件成立"。成立 → ok=1（无害）；不成立 → CHECK 失败 → 整批回滚。
  return env.db
    .prepare(
      `INSERT INTO storage_batch_guard (id, ok) VALUES (1, CASE WHEN ${condition} THEN 1 ELSE 0 END)
       ON CONFLICT (id) DO UPDATE SET ok = excluded.ok`,
    )
    .bind(...params);
}

/** "存在且可写"：非运行时写入必须尊重既有对象的 write 位。 */
function writableObjectExistsSql(authoritative: boolean): string {
  return (
    "EXISTS (SELECT 1 FROM storage_objects WHERE tenant_id = ?1 AND collection = ?2 AND key = ?3 AND user_id = ?4" +
    (authoritative ? ")" : " AND storage_objects.write_perm = 1)")
  );
}

/** "存在"：只用于 `version = "*"`（只许新建）这一条路径。 */
const OBJECT_EXISTS_SQL =
  "EXISTS (SELECT 1 FROM storage_objects WHERE tenant_id = ?1 AND collection = ?2 AND key = ?3 AND user_id = ?4)";

/** "存在且版本与期望一致"：OCC 写入的守卫（非运行时额外要求既有对象可写）。 */
function versionMatchSql(authoritative: boolean): string {
  return (
    "EXISTS (SELECT 1 FROM storage_objects WHERE tenant_id = ?1 AND collection = ?2 AND key = ?3" +
    " AND user_id = ?4 AND version = ?5" +
    (authoritative ? ")" : " AND write_perm = 1)")
  );
}

function upsertStatement(env: StorageEnv, ownerId: string, op: WriteOp, authoritative: boolean): PreparedStatement {
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

function occStatement(env: StorageEnv, ownerId: string, op: WriteOp, authoritative: boolean): PreparedStatement {
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

function sortKey(op: WriteOp, ownerId: string): string {
  return `${op.collection}\u0000${op.key}\u0000${ownerId}`;
}

export interface WriteOptions {
  /** 运行时写入（对应的上游调用把 authoritativeWrite 置 true）：跳过写权限检查。 */
  readonly authoritative?: boolean;
}

/**
 * 批量写对象。返回的 acks **按请求顺序**（上游用 `indexedOps` 把排序后的结果映射回去）。
 * 任意一条被拒 → 整批回滚并抛出对应的 `ApiError`。
 */
export async function writeObjects(
  env: StorageEnv,
  ownerId: string,
  ops: readonly WriteOp[],
  options: WriteOptions = {},
): Promise<Ack[]> {
  if (ops.length === 0) return [];
  const authoritative = options.authoritative === true;

  const ordered = ops
    .map((op, index) => ({ op, index }))
    .sort((left, right) => {
      const a = sortKey(left.op, ownerId);
      const b = sortKey(right.op, ownerId);
      return a < b ? -1 : a > b ? 1 : left.index - right.index;
    });

  const statements: PreparedStatement[] = [];
  for (const { op } of ordered) {
    // 守卫与写入交错：同一批里对同一个 key 的两次写必须按顺序互相看见（上游是批内顺序执行）。
    if (op.version === "") {
      // 不存在 → 可以建；已存在 → 必须尊重既有对象的 write 位（运行时写入跳过这一条）。
      statements.push(
        guardStatement(env, `NOT ${OBJECT_EXISTS_SQL} OR ${writableObjectExistsSql(authoritative)}`, [
          env.tenantId,
          op.collection,
          op.key,
          ownerId,
        ]),
      );
      statements.push(upsertStatement(env, ownerId, op, authoritative));
      continue;
    }
    if (op.version === "*") {
      statements.push(
        guardStatement(env, `NOT ${OBJECT_EXISTS_SQL}`, [env.tenantId, op.collection, op.key, ownerId]),
      );
      statements.push(insertOnlyStatement(env, ownerId, op));
      continue;
    }
    statements.push(
      guardStatement(
        env,
        versionMatchSql(authoritative),
        [env.tenantId, op.collection, op.key, ownerId, op.version],
      ),
    );
    statements.push(occStatement(env, ownerId, op, authoritative));
  }
  statements.push(env.db.prepare("DELETE FROM storage_batch_guard"));

  let results: D1Result<StorageObjectRow>[];
  try {
    results = await env.db.batch<StorageObjectRow>(statements);
  } catch (error) {
    // 守卫拦下了这批判定：按上游顺序找出第一个违规的 op，报它对应的错误。
    for (const { op } of ordered) {
      const failure = await classifyFirstFailure(env, ownerId, op, authoritative);
      if (failure !== null) throw failure;
    }
    throw error;
  }

  const acks: Ack[] = new Array<Ack>(ops.length);
  const missing: { op: WriteOp; index: number }[] = [];
  ordered.forEach(({ op, index }, orderedIndex) => {
    const dataResult = results[orderedIndex * 2 + 1];
    const row = dataResult?.results?.[0];
    if (row === undefined) {
      // 版本未变（上游的"值完全相同就不更新"微优化）或插入被 DO NOTHING 掉：
      // 这两种情况对象一定存在且状态就是我们要的，补一次读即可。
      missing.push({ op, index });
      return;
    }
    acks[index] = {
      collection: row.collection,
      key: row.key,
      version: row.version,
      userId: row.user_id,
      createTime: row.create_time,
      updateTime: row.update_time,
    };
  });

  if (missing.length > 0) {
    for (const { op, index } of missing) {
      const row = await findObject(env, ownerId, op.collection, op.key);
      if (row === null) throw internal("Error writing storage objects.");
      acks[index] = {
        collection: row.collection,
        key: row.key,
        version: row.version,
        userId: row.user_id,
        createTime: row.create_time,
        updateTime: row.update_time,
      };
    }
  }

  return acks;
}

/** 单条 op 的"会不会被拒"判定：不违规返回 null。 */
async function classifyFirstFailure(
  env: StorageEnv,
  ownerId: string,
  op: WriteOp,
  authoritative: boolean,
): Promise<ApiError | null> {
  const row = await findObject(env, ownerId, op.collection, op.key);
  switch (op.version) {
    case "":
      if (!authoritative && row !== null && row.write_perm !== 1) {
        return new ApiError(Code.InvalidArgument, PERMISSION_REJECTED_MESSAGE);
      }
      return null;
    case "*":
      return row === null ? null : new ApiError(Code.FailedPrecondition, VERSION_REJECTED_MESSAGE);
    default: {
      if (row === null) return new ApiError(Code.FailedPrecondition, VERSION_REJECTED_MESSAGE);
      if (!authoritative && row.write_perm !== 1) {
        return new ApiError(Code.InvalidArgument, PERMISSION_REJECTED_MESSAGE);
      }
      return row.version === op.version
        ? null
        : new ApiError(Code.FailedPrecondition, VERSION_REJECTED_MESSAGE);
    }
  }
}

export async function findObject(
  env: StorageEnv,
  ownerId: string,
  collection: string,
  key: string,
): Promise<StorageObjectRow | null> {
  return env.db
    .prepare(
      "SELECT collection, key, user_id, value, version, read_perm, write_perm, create_time, update_time " +
        "FROM storage_objects WHERE tenant_id = ?1 AND collection = ?2 AND key = ?3 AND user_id = ?4",
    )
    .bind(env.tenantId, collection, key, ownerId)
    .first<StorageObjectRow>();
}

export interface ReadObjectId {
  readonly collection: string;
  readonly key: string;
  readonly userId: string;
}

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
        "SELECT collection, key, user_id, value, version, read_perm, write_perm, create_time, update_time " +
          "FROM storage_objects WHERE tenant_id = ?1 AND collection = ?2 AND key = ?3 AND user_id = ?4" +
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

export interface DeleteOp {
  readonly collection: string;
  readonly key: string;
  /** `""` = 无条件删除；否则必须是当前版本。 */
  readonly version: string;
}

/** 批量删除。任意一条删不到（不存在 / 版本不符 / 无写权限）→ 整批回滚。 */
export async function deleteObjects(
  env: StorageEnv,
  ownerId: string,
  ops: readonly DeleteOp[],
  options: { readonly authoritative?: boolean } = {},
): Promise<void> {
  if (ops.length === 0) return;
  const authoritative = options.authoritative === true;

  const ordered = [...ops].sort((left, right) => {
    const a = `${left.collection}\u0000${left.key}`;
    const b = `${right.collection}\u0000${right.key}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const statements: PreparedStatement[] = [];
  for (const op of ordered) {
    const writeGuard = authoritative ? "" : " AND write_perm > 0";
    const versionGuard = op.version === "" ? "" : " AND version = ?5";
    // 运行时删除且不带版本时，"删不到"是合法的空操作——上游**照删**，只是跳过
    // `rowsAffected == 0 → 拒绝` 那一步（`storageDeleteObjects` 里的 `continue` 在
    // `tx.Exec` 之后）。所以这里省掉的是守卫，不是 DELETE 本身。
    if (!(authoritative && op.version === "")) {
      statements.push(
        guardStatement(
          env,
          `EXISTS (SELECT 1 FROM storage_objects WHERE tenant_id = ?1 AND collection = ?2 AND key = ?3 ` +
            `AND user_id = ?4${writeGuard}${versionGuard})`,
          op.version === ""
            ? [env.tenantId, op.collection, op.key, ownerId]
            : [env.tenantId, op.collection, op.key, ownerId, op.version],
        ),
      );
    }
    statements.push(
      env.db
        .prepare(
          "DELETE FROM storage_objects WHERE tenant_id = ?1 AND collection = ?2 AND key = ?3 AND user_id = ?4" +
            writeGuard +
            versionGuard,
        )
        .bind(
          ...(op.version === ""
            ? [env.tenantId, op.collection, op.key, ownerId]
            : [env.tenantId, op.collection, op.key, ownerId, op.version]),
        ),
    );
  }
  statements.push(env.db.prepare("DELETE FROM storage_batch_guard"));

  try {
    await env.db.batch(statements);
  } catch {
    throw new ApiError(Code.InvalidArgument, DELETE_REJECTED_MESSAGE);
  }
}

export interface ListResult {
  readonly objects: StorageObjectRow[];
  readonly cursor: string;
}

export interface ListOptions {
  readonly collection: string;
  /** 运行时列举任意所有者时为 null；客户端不留 ownerId 时表示"只看公共可读"。 */
  readonly ownerId: string | null;
  readonly limit: number;
  readonly cursor: string;
  readonly authoritative?: boolean;
}

const OBJECT_COLUMNS =
  "collection, key, user_id, value, version, read_perm, write_perm, create_time, update_time";

/**
 * 列举对象。三条路径与上游一一对应：
 *   1. 不过滤所有者：只列公共可读（`read_perm >= 2`），按 (read_perm, key, user_id) 升序；
 *   2. 列自己：`read_perm >= 1`，按 (read_perm, key) 升序；
 *   3. 列别人的：只列公共可读（`read_perm = 2`），按 key 升序；
 *   4. 运行时（authoritative）不受读权限限制，按 (read_perm, key, user_id) 升序。
 */
export async function listObjects(env: StorageEnv, callerId: string, options: ListOptions): Promise<ListResult> {
  // 运行时路径（调用者是全零 UUID）不受读权限限制；上游 `StorageListObjects` 的
  // `if caller == uuid.Nil { … true … }` 分支与此一一对应。
  const authoritative = options.authoritative === true || callerId === NIL_USER_ID;
  const limit = options.limit;
  const decoding = options.cursor === "" ? null : decodeCursor(options.cursor);

  let where: string;
  let orderBy: string;
  let params: unknown[];
  let cursorPredicate: string;

  if (options.ownerId === null) {
    if (authoritative) {
      where = "tenant_id = ?1 AND collection = ?2";
      orderBy = "read_perm ASC, key ASC, user_id ASC";
      cursorPredicate = "(read_perm, key, user_id) > (?3, ?4, ?5)";
    } else {
      where = "tenant_id = ?1 AND collection = ?2 AND read_perm >= 2";
      orderBy = "read_perm ASC, key ASC, user_id ASC";
      cursorPredicate = "(read_perm, key, user_id) > (2, ?3, ?4)";
    }
  } else if (options.ownerId === callerId && !authoritative) {
    where = "tenant_id = ?1 AND collection = ?2 AND user_id = ?3 AND read_perm >= 1";
    orderBy = "read_perm ASC, key ASC";
    cursorPredicate = "(read_perm, key) > (?4, ?5)";
  } else if (options.ownerId === callerId) {
    where = "tenant_id = ?1 AND collection = ?2 AND user_id = ?3";
    orderBy = "read_perm ASC, key ASC";
    cursorPredicate = "(read_perm, key) > (?4, ?5)";
  } else if (authoritative) {
    where = "tenant_id = ?1 AND collection = ?2 AND user_id = ?3";
    orderBy = "read_perm ASC, key ASC";
    cursorPredicate = "(read_perm, key) > (?4, ?5)";
  } else {
    where = "tenant_id = ?1 AND collection = ?2 AND user_id = ?3 AND read_perm = 2";
    orderBy = "key ASC";
    cursorPredicate = "key > ?4";
  }

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
    `SELECT ${OBJECT_COLUMNS} FROM storage_objects WHERE ${where}` +
    (decoding === null ? "" : ` AND ${cursorPredicate}`) +
    ` ORDER BY ${orderBy} LIMIT ?${params.length}`;

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
