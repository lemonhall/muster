import { Code } from "../../src/http/grpc";
import { ApiError } from "../../src/http/errors";
import {
  NIL_USER_ID,
  deleteObjects,
  listObjects,
  readObjects,
  writeObjects,
  type Ack,
  type DeleteOp,
  type ReadObjectId,
  type StorageEnv,
  type StorageObjectRow,
  type WriteOp,
} from "../../src/domain/storage/objects";

/**
 * 存储契约测试的公共工装。
 *
 * 上游 `core_storage_test.go` 把"直接调核心函数、把返回的三元组 `(acks, code, err)`
 * 拿去断言"这套写法重复了 54 遍；我们把重复的那部分抽到这里，让每个测试文件只留下
 * 与被测行为有关的断言。
 *
 * 两条调用路径就是上游测试名里的那对字眼：
 * - `…Runtime…`：运行时写，`{ authoritative: true }` —— 跳过写权限位；
 * - `…Pipeline…`：客户端写，默认 `authoritative: false` —— 必须尊重既有对象的写位。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_storage.go::StorageWriteObjects
 * 契约源: server/core_storage.go::StorageReadObjects
 * 契约源: server/core_storage.go::StorageDeleteObjects
 * 契约源: server/core_storage.go::StorageListObjects
 */

export { Code } from "../../src/http/grpc";
export { ApiError } from "../../src/http/errors";
export { encodeCursor } from "../../src/domain/storage/cursor";
export {
  NIL_USER_ID,
  deleteObjects,
  listObjects,
  readObjects,
  writeObjects,
  type Ack,
  type DeleteOp,
  type ReadObjectId,
  type StorageEnv,
  type StorageObjectRow,
  type WriteOp,
} from "../../src/domain/storage/objects";
export {
  OTHER_TENANT,
  STORAGE_TENANT,
  expectedVersion,
  generateString,
  insertUser,
  newUserId,
  storageEnv,
} from "./storage";

export const READ_PRIVATE = 0;
export const READ_OWNER = 1;
export const READ_PUBLIC = 2;

export const WRITE_REJECTED_VERSION = "Storage write rejected - version check failed.";
export const WRITE_REJECTED_PERMISSION = "Storage write rejected - permission denied.";
export const DELETE_REJECTED =
  "Storage delete rejected - not found, version check failed, or permission denied.";

/** 上游测试里的 `*api.StorageObject`：字段名与 proto 一一对应，便于逐条比对断言。 */
export interface WireObject {
  readonly collection: string;
  readonly key: string;
  readonly userId: string;
  readonly value: string;
  readonly version: string;
  readonly permissionRead: number;
  readonly permissionWrite: number;
  readonly createTime: number;
  readonly updateTime: number;
}

export function wire(row: StorageObjectRow): WireObject {
  return {
    collection: row.collection,
    key: row.key,
    userId: row.user_id,
    value: row.value,
    version: row.version,
    permissionRead: row.read_perm,
    permissionWrite: row.write_perm,
    createTime: row.create_time,
    updateTime: row.update_time,
  };
}

/**
 * 上游 `WriteStorageObject` 的构造器。`version` 缺省是 `""`（无条件覆盖）。
 *
 * 三个可选参数都显式带 `| undefined`：本仓库开了 `exactOptionalPropertyTypes`，
 * 而测试里大量出现 `version: ack.version`（类型是 `string | undefined`）这种写法。
 */
export function op(params: {
  readonly collection: string;
  readonly key: string;
  readonly value: string;
  readonly version?: string | undefined;
  readonly read?: number | undefined;
  readonly write?: number | undefined;
}): WriteOp {
  return {
    collection: params.collection,
    key: params.key,
    value: params.value,
    version: params.version ?? "",
    // 上游 `permissionRead()` / `permissionWrite()` 对 nil 的缺省值是 1。
    permissionRead: params.read ?? READ_OWNER,
    permissionWrite: params.write ?? READ_OWNER,
  };
}

/** 上游返回值三元组 `(acks, code, err)` 的等价物。 */
export interface Outcome<T> {
  readonly value: T | null;
  readonly code: number;
  readonly error: string | null;
}

export async function attempt<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { value: await fn(), code: Code.OK, error: null };
  } catch (error) {
    if (error instanceof ApiError) return { value: null, code: error.code, error: error.message };
    throw error;
  }
}

export function attemptWrite(
  env: StorageEnv,
  ownerId: string,
  ops: readonly WriteOp[],
  authoritative = false,
): Promise<Outcome<Ack[]>> {
  return attempt(() => writeObjects(env, ownerId, ops, { authoritative }));
}

export function attemptDelete(
  env: StorageEnv,
  ownerId: string,
  ops: readonly DeleteOp[],
  authoritative = false,
): Promise<Outcome<void>> {
  return attempt(() => deleteObjects(env, ownerId, ops, { authoritative }));
}

export function attemptList(
  env: StorageEnv,
  callerId: string,
  options: Parameters<typeof listObjects>[2],
): Promise<Outcome<Awaited<ReturnType<typeof listObjects>>>> {
  return attempt(() => listObjects(env, callerId, options));
}

/** 读对象并把行映射成 proto 形状，便于断言权限位与时间戳。 */
export async function read(
  env: StorageEnv,
  callerId: string,
  ids: readonly ReadObjectId[],
  authoritative = false,
): Promise<WireObject[]> {
  const rows = await readObjects(env, callerId, ids, { authoritative });
  return rows.map(wire);
}
