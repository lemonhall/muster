/**
 * 存储引擎的类型与常量。
 *
 * 名字尽量与上游 `server/core_storage.go` 里的概念同名同义：SQL / proto 层面的字段
 * 用 snake_case（`read_perm`、`user_id`），需要换成 JSON 的 camelCase 由
 * `src/wire/storage.ts` 负责，领域层不掺传输格式。
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

export interface WriteOptions {
  /** 运行时写入（对应的上游调用把 authoritativeWrite 置 true）：跳过写权限检查。 */
  readonly authoritative?: boolean;
}

export interface ReadObjectId {
  readonly collection: string;
  readonly key: string;
  readonly userId: string;
}

export interface DeleteOp {
  readonly collection: string;
  readonly key: string;
  /** `""` = 无条件删除；否则必须是当前版本。 */
  readonly version: string;
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
