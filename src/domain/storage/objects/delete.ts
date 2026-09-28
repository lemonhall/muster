/**
 * 批量删除。任意一条删不到（不存在 / 版本不符 / 无写权限）→ 整批回滚。
 *
 * 原子性机制与写入一致（守卫语句 + `storage_batch_guard` 的 CHECK 约束）。
 */

import { Code } from "../../../http/grpc";
import { ApiError } from "../../../http/errors";
import { guardStatement, type PreparedStatement } from "./sql";
import { DELETE_REJECTED_MESSAGE, type DeleteOp, type StorageEnv } from "./types";

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
    const params =
      op.version === ""
        ? [env.tenantId, op.collection, op.key, ownerId]
        : [env.tenantId, op.collection, op.key, ownerId, op.version];
    // 运行时删除且不带版本时，"删不到"是合法的空操作——上游**照删**，只是跳过
    // `rowsAffected == 0 → 拒绝` 那一步（`storageDeleteObjects` 里的 `continue` 在
    // `tx.Exec` 之后）。所以这里省掉的是守卫，不是 DELETE 本身。
    if (!(authoritative && op.version === "")) {
      statements.push(
        guardStatement(
          env,
          `EXISTS (SELECT 1 FROM storage_objects WHERE tenant_id = ?1 AND collection = ?2 AND key = ?3 ` +
            `AND user_id = ?4${writeGuard}${versionGuard})`,
          params,
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
        .bind(...params),
    );
  }
  statements.push(env.db.prepare("DELETE FROM storage_batch_guard"));

  try {
    await env.db.batch(statements);
  } catch {
    throw new ApiError(Code.InvalidArgument, DELETE_REJECTED_MESSAGE);
  }
}
