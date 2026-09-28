/**
 * 租户运行时模块仓：`runtime_modules` 表的读写。
 *
 * 表的主键是 `(tenant_id, name, revision)`，`revision` 对同一个 `(tenant_id, name)`
 * 单调递增。这带来一个很舒服的性质：**"换代码"就是换 revision**，而装载端的缓存键
 * 由当前最新 revisions 拼出来——代码不变时键不变，isolate 就不会被重建。
 *
 * 两条查询都**必须**带 `tenant_id`（ECN-0001）：多租户下"读模块"是最容易被写成
 * 全表扫描的一件事，一旦漏掉租户条件，A 租户的游戏脚本就能被 B 租户装载。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime.go::Runtime
 *
 * REQ-0001-020
 */

export interface TenantModule {
  readonly name: string;
  readonly revision: number;
  readonly source: string;
}

/**
 * 取每个模块的**最新版本**，按名字升序。
 *
 * 用 `JOIN` 而不是相关子查询：D1 的查询规划对 `GROUP BY` + 连接更稳，
 * 而且这条 SQL 的意图"每个 name 取 max(revision)"在字面上就能读出来。
 */
export async function listLatestModules(
  db: D1Database,
  tenantId: string,
): Promise<TenantModule[]> {
  const result = await db
    .prepare(
      `SELECT m.name AS name, m.revision AS revision, m.source AS source
         FROM runtime_modules m
         JOIN (
           SELECT name, MAX(revision) AS revision
             FROM runtime_modules
            WHERE tenant_id = ?1
            GROUP BY name
         ) latest
           ON latest.name = m.name AND latest.revision = m.revision
        WHERE m.tenant_id = ?1
        ORDER BY m.name ASC`,
    )
    .bind(tenantId)
    .all<TenantModule>();
  return result.results;
}

/**
 * 写一个新版本，返回它的 revision。
 *
 * 先读 `MAX(revision)` 再写：D1 的单条语句之间没有事务，所以两个并发的部署可能
 * 撞到同一个 revision——主键会让其中一条失败（**大声失败**），而不是静默覆盖。
 * 这与"部署是运维动作、不需要高并发"的假设一致，也是我们想要的失败方向。
 */
export async function putModule(
  db: D1Database,
  tenantId: string,
  name: string,
  source: string,
  createdAt: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(MAX(revision), 0) AS revision FROM runtime_modules WHERE tenant_id = ?1 AND name = ?2",
    )
    .bind(tenantId, name)
    .first<{ revision: number }>();
  const revision = (row?.revision ?? 0) + 1;
  await db
    .prepare(
      "INSERT INTO runtime_modules (tenant_id, name, revision, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(tenantId, name, revision, source, createdAt)
    .run();
  return revision;
}

export async function deleteModule(
  db: D1Database,
  tenantId: string,
  name: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM runtime_modules WHERE tenant_id = ?1 AND name = ?2")
    .bind(tenantId, name)
    .run();
}

/**
 * 装载缓存键：把"这一批模块各自的版本"拼成一个签名再哈希。
 *
 * 直接用 `name@revision` 拼接也行，但键会随模块名变长而膨胀；哈希之后长度恒定，
 * 而且"内容不同 → 键不同"这件事仍然是**密码学**保证的。租户 id 显式留在前缀里，
 * 让"哪个 isolate 属于谁"在日志与缓存里一眼可见。
 */
export async function revisionKey(tenantId: string, modules: readonly TenantModule[]): Promise<string> {
  const signature = modules
    .map((module) => `${module.name}@${module.revision}`)
    .sort()
    .join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signature));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${tenantId}:${hex}`;
}
