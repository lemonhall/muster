/**
 * **群本身**（`groups` 表）的写语句：建、改、删、计数、以及成员边的下一个 position。
 *
 * 与 `edges.ts` 的分工是"写哪张表"，不是"哪个端点"：这里动的是群那一行，
 * `edges.ts` 动的是成员边那两行。两类写偶尔在同一个批次里（建群 = 一行群 + 两行边），
 * 但批次由调用方拼，语句各自留在自己那张表的文件里。
 *
 * 三条从上游搬来的形状：
 *   1. **重名靠 `WHERE NOT EXISTS` 判定**（0 行 = 名字被占用），不捕获约束错误——
 *      错误文案是运行时细节，不该变成业务分支的条件；
 *   2. **"没有新字段"靠 `AND col <> 新值` 显式判等**：Postgres 的 `RowsAffected`
 *      只数真正变化的行，SQLite 的 changes 数匹配行，不显式排除就会得到不同的答案；
 *   3. **成员计数与容量条件同写一句 SQL**（`edge_count + 1 <= max_count`），
 *      于是"能不能写"和"计数是多少"不会各自为政。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_group.go::CreateGroup
 * 契约源: server/core_group.go::UpdateGroup
 * 契约源: server/core_group.go::deleteGroup
 *
 * REQ-0001-012
 */

import { pairInsert } from "./edges";

/**
 * 建群：插一行群。`edge_count` 直接写成 1（上游 `CreateGroup` 的尾参数），
 * 所以创建者那条边不参与计数（见 `insertCreatorEdge` 的 `exists` 守卫）。
 */
export function insertGroup(
  db: D1Database,
  tenantId: string,
  group: {
    readonly id: string;
    readonly creatorId: string;
    readonly name: string;
    readonly description: string;
    readonly avatarUrl: string;
    readonly langTag: string;
    readonly metadata: string;
    readonly open: boolean;
    readonly maxCount: number;
    readonly now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO groups (tenant_id, id, creator_id, name, description, avatar_url, lang_tag,
                           metadata, open, edge_count, max_count, create_time, update_time)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?11, ?11
       WHERE NOT EXISTS (SELECT 1 FROM groups WHERE tenant_id = ?1 AND name = ?4)`,
    )
    .bind(
      tenantId,
      group.id,
      group.creatorId,
      group.name,
      group.description,
      group.avatarUrl,
      group.langTag,
      group.metadata,
      group.open ? 1 : 0,
      group.maxCount,
      group.now,
    );
}

/** 建群时创建者那一对边（`exists` 守卫：群存在才写，不看容量）。 */
export function insertCreatorEdge(
  db: D1Database,
  tenantId: string,
  groupId: string,
  userId: string,
  position: number,
  now: number,
): D1PreparedStatement[] {
  return [pairInsert(db, tenantId, groupId, groupId, userId, 0, position, now, "exists")];
}

/** 改群能改的字段；`undefined` 表示"这次不动它"。 */
export interface GroupFieldPatch {
  readonly name?: string;
  readonly langTag?: string;
  readonly description?: string;
  readonly avatarUrl?: string;
  readonly open?: boolean;
  readonly metadata?: string;
  readonly maxCount?: number;
}

/**
 * 改群：每个 `SET` 都配一个同名 `AND col <> 新值` 进 `WHERE`。
 *
 * 这不是优化，是 `No new fields in group update.` 的来源：全部字段都传旧值时必须是
 * 0 行。字段顺序与上游 `UpdateGroup` 里拼 `statements` 的顺序一致（name、lang、desc、
 * avatar、open、metadata、max_count），虽然对结果没有影响，但对"读代码时两处能对上"有。
 */
export function updateGroupFields(
  db: D1Database,
  tenantId: string,
  groupId: string,
  patch: GroupFieldPatch,
  now: number,
): D1PreparedStatement {
  const params: unknown[] = [tenantId, groupId];
  const sets: string[] = [`update_time = ?${push(params, now)}`];
  const conditions: string[] = [];
  const assign = (column: string, value: unknown): void => {
    const index = push(params, value);
    sets.push(`${column} = ?${index}`);
    conditions.push(`${column} <> ?${index}`);
  };
  if (patch.name !== undefined) assign("name", patch.name);
  if (patch.langTag !== undefined) assign("lang_tag", patch.langTag);
  if (patch.description !== undefined) assign("description", patch.description);
  if (patch.avatarUrl !== undefined) assign("avatar_url", patch.avatarUrl);
  if (patch.open !== undefined) assign("open", patch.open ? 1 : 0);
  if (patch.metadata !== undefined) assign("metadata", patch.metadata);
  if (patch.maxCount !== undefined) assign("max_count", patch.maxCount);
  const guard = conditions.length === 0 ? "" : ` AND (${conditions.join(" OR ")})`;
  return db
    .prepare(`UPDATE groups SET ${sets.join(", ")} WHERE tenant_id = ?1 AND id = ?2${guard}`)
    .bind(...params);
}

/**
 * 删群：先删群本身，再删它作为 `source` 或 `destination` 的**全部**边。
 *
 * 顺序不能反：先删边的话第二句仍然按 group id 命中，但两句都在同一批次里，
 * 顺序只影响可读性——上游 `deleteGroup` 就是这个顺序，照抄。
 */
export function deleteGroupStatements(
  db: D1Database,
  tenantId: string,
  groupId: string,
): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM groups WHERE tenant_id = ?1 AND id = ?2").bind(tenantId, groupId),
    db
      .prepare(
        "DELETE FROM group_edge WHERE tenant_id = ?1 AND (source_id = ?2 OR destination_id = ?2)",
      )
      .bind(tenantId, groupId),
  ];
}

/** 群成员计数增减（`delta` 只有两个取值，SQL 片段由它二选一，不拼接外部输入）。 */
export function bumpGroupEdgeCount(
  db: D1Database,
  tenantId: string,
  groupId: string,
  delta: 1 | -1,
  now: number,
): Promise<D1Result> {
  return db
    .prepare(
      `UPDATE groups SET edge_count = edge_count ${delta > 0 ? "+" : "-"} 1, update_time = ?3
       WHERE tenant_id = ?1 AND id = ?2`,
    )
    .bind(tenantId, groupId, now)
    .run();
}

/**
 * 群成员边的下一个 `position`：`MAX(position) + 1`（同一租户内单调递增）。
 *
 * 上游用的是 `time.Now().UnixNano()`，它有两个性质：**越大越新**、**同一次写入的两行
 * 共用同一个值**。本项目用单调计数保第一条（纳秒超过 JS 安全整数范围，进游标会静默
 * 丢精度），第二条由调用方"每次操作算一次、两行共用"保证。
 */
export async function nextGroupPosition(db: D1Database, tenantId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM group_edge WHERE tenant_id = ?1")
    .bind(tenantId)
    .first<{ next: number }>();
  return row?.next ?? 1;
}

function push(params: unknown[], value: unknown): number {
  params.push(value);
  return params.length;
}
