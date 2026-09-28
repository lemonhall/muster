/**
 * 批量写对象。
 *
 * 语义逐条取自上游 `server/core_storage.go::StorageWriteObjects` / `storageWriteObjects`，
 * **包括它反直觉的地方**：
 *
 * - `version = ""` → 无条件覆盖（last write wins），但仍要过写权限；
 * - `version = "*"` → 只允许新建（对象已存在即拒绝）；
 * - `version = <md5>` → 乐观锁，版本不符即拒绝；
 * - 拒绝时的错误码与消息是"权限"和"版本"哪个先成立决定（见 `classifyFirstFailure`）；
 * - 返回值里的 acks **按请求顺序**，不是按批内排序后的顺序。
 */

import { Code } from "../../../http/grpc";
import { ApiError, internal } from "../../../http/errors";
import {
  OBJECT_EXISTS_SQL,
  findObject,
  guardStatement,
  sortKey,
  versionMatchSql,
  writableObjectExistsSql,
  writeStatement,
  type PreparedStatement,
} from "./sql";
import {
  PERMISSION_REJECTED_MESSAGE,
  VERSION_REJECTED_MESSAGE,
  type Ack,
  type StorageEnv,
  type StorageObjectRow,
  type WriteOp,
  type WriteOptions,
} from "./types";

function ackOf(row: StorageObjectRow): Ack {
  return {
    collection: row.collection,
    key: row.key,
    version: row.version,
    userId: row.user_id,
    createTime: row.create_time,
    updateTime: row.update_time,
  };
}

/**
 * 批量写。任意一条被拒 → 整批回滚并抛出对应的 `ApiError`。
 *
 * 原子性靠 D1 的 `batch()`（单事务）加一条**守卫语句**：每一步先插一行
 * `storage_batch_guard(ok = CASE WHEN <前置条件> THEN 1 ELSE 0 END)`，表上有
 * `CHECK (ok = 1)`，条件不成立就让整批回滚；条件成立时守卫行在同一批末尾被删掉，
 * 表始终是空的。前置条件写在数据库里而不是应用层，所以"要么全成功要么全失败"是
 * 数据库保证的。
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
    } else if (op.version === "*") {
      statements.push(
        guardStatement(env, `NOT ${OBJECT_EXISTS_SQL}`, [env.tenantId, op.collection, op.key, ownerId]),
      );
    } else {
      statements.push(
        guardStatement(env, versionMatchSql(authoritative), [
          env.tenantId,
          op.collection,
          op.key,
          ownerId,
          op.version,
        ]),
      );
    }
    statements.push(writeStatement(env, ownerId, op, authoritative));
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
    // 每条 op 固定两条语句（守卫 + 写入），所以数据语句的下标是 2i + 1。
    const row = results[orderedIndex * 2 + 1]?.results?.[0];
    if (row === undefined) {
      // 版本未变（上游的"值完全相同就不更新"微优化）或插入被 DO NOTHING 掉：
      // 这两种情况对象一定存在且状态就是我们要的，补一次读即可。
      missing.push({ op, index });
      return;
    }
    acks[index] = ackOf(row);
  });

  for (const { op, index } of missing) {
    const row = await findObject(env, ownerId, op.collection, op.key);
    if (row === null) throw internal("Error writing storage objects.");
    acks[index] = ackOf(row);
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
