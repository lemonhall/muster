import { env } from "cloudflare:test";

import { md5Hex } from "../../src/domain/storage/md5";
import type { StorageEnv } from "../../src/domain/storage/objects";

/**
 * 存储测试的工装。
 *
 * 与上游 `core_storage_test.go` 的 `NewDB` / `InsertUser` / `GenerateString` 一一对应：
 * 上游每个用例起一个真实 Postgres 库，我们每个用例直接落在本地 D1 的同构 schema 上
 * （vitest-pool-workers 的隔离存储保证用例之间互不可见）。
 *
 * 存储测试用**自己的租户 id**，不去动 `tenants`/`users` 里别的东西：存储表没有外键，
 * 上游的 `InsertUser` 只是满足它那边的引用完整性，我们如实照做一次，但**不依赖它**——
 * 这样即便别的测试文件并发清空 `users`，存储语义的结论也不会飘。
 */

export const STORAGE_TENANT = "CCCCCCCC-0000-4000-8000-0000000000CC";
export const OTHER_TENANT = "DDDDDDDD-0000-4000-8000-0000000000DD";

export function storageEnv(tenantId: string = STORAGE_TENANT, nowSec = 1_700_000_000): StorageEnv {
  return { db: env.DB, tenantId, nowSec };
}

/** 上游 `GenerateString()`：随机标识，用来避免用例之间撞键。 */
export function generateString(): string {
  return crypto.randomUUID();
}

/** 上游 `InsertUser(t, db, uid)`：库里有这个用户就行（我们没有外键，只是照做）。 */
export async function insertUser(tenantId: string, userId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO users (tenant_id, id, username, create_time, update_time) VALUES (?1, ?2, ?3, ?4, ?4)",
  )
    .bind(tenantId, userId, `user-${userId}`.slice(0, 120), now)
    .run();
}

/** 上游的 `uuid.Must(uuid.NewV4()).String()`：测试里当"某个用户"。 */
export function newUserId(): string {
  return crypto.randomUUID().toUpperCase();
}

/** 上游测试反复用 `fmt.Sprintf("%x", md5.Sum([]byte(value)))` 算期望版本号。 */
export function expectedVersion(value: string): string {
  return md5Hex(value);
}
