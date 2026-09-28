/**
 * 租户登记。server key 只以 SHA-256 形态落库；明文在开通时一次性打印给运营者。
 *
 * 为什么要哈希而不是明文：多租户下这张表是"谁能进哪个游戏"的关口，
 * 一次数据库泄漏如果带走明文 key，等于所有租户的认证入口一起失守。
 * 校验用索引查哈希（等价于定长比较），不需要恒时比较明文。
 */

export interface TenantRow {
  readonly id: string;
  readonly name: string;
  readonly server_key_hash: string;
  readonly create_time: number;
  readonly disable_time: number;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 按 server key 明文反查租户；查不到或已禁用都返回 `null`（对外统一是 401）。 */
export async function findTenantByServerKey(db: D1Database, serverKey: string): Promise<TenantRow | null> {
  const hash = await sha256Hex(serverKey);
  const row = await db
    .prepare("SELECT id, name, server_key_hash, create_time, disable_time FROM tenants WHERE server_key_hash = ?1")
    .bind(hash)
    .first<TenantRow>();
  if (row === null) return null;
  if (row.disable_time !== 0) return null;
  return row;
}

export async function findTenantById(db: D1Database, tenantId: string): Promise<TenantRow | null> {
  const row = await db
    .prepare("SELECT id, name, server_key_hash, create_time, disable_time FROM tenants WHERE id = ?1")
    .bind(tenantId)
    .first<TenantRow>();
  if (row === null) return null;
  if (row.disable_time !== 0) return null;
  return row;
}
