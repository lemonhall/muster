/**
 * 对局目录的存储层：`match_record` 表（D1）。
 *
 * 谁写这张表：**权威/中继对局的 DO**。每个对局实例在创建、成员变动、标签更新、
 * 结束时各写一次，于是列表端点只需要读一张表——上游是"权威对局查 bluge 索引 +
 * 中继对局数 tracker"，两条路各有各的坑（索引重建、tracker 只有本节点），
 * 合并成一条读路径是本项目的形态差异（ECN-0011 偏差 2）。
 *
 * 一次列表最多看 `LISTING_SCAN_CAP` 行。为什么要有这个上限：查询串的打分必须扫过
 * 候选集（上游的 bluge 也是全索引检索），而 D1 没有"按相关性取前 N"的能力。
 * 上限**只影响"超过一万个活跃对局时更老的会被忽略"**，不影响任何断言；
 * 客户端能要的 `limit` 最大是 100。
 *
 * 契约源（机器可读）：
 * 契约源: server/match_registry.go::LocalMatchRegistry.ListMatches
 * 契约源: server/match_registry.go::LocalMatchRegistry.UpdateMatchLabel
 *
 * REQ-0001-018
 */

import { listMatches, type MatchListFilters, type MatchRecord } from "./catalog";

export const LISTING_SCAN_CAP = 10_000;

interface RecordRow {
  readonly match_id: string;
  readonly node: string;
  readonly authoritative: number;
  readonly label: string;
  readonly size: number;
  readonly create_time: number;
  readonly [column: string]: SqlStorageValue;
}

/** 落一行对局记录（创建与标签更新共用；主键是 `(tenant_id, match_id)`）。 */
export async function upsertMatchRecord(
  db: D1Database,
  tenantId: string,
  record: MatchRecord,
): Promise<void> {
  const uuid = record.matchId.split(".")[0] ?? "";
  await db
    .prepare(
      `INSERT INTO match_record
         (tenant_id, match_id, uuid, node, authoritative, label, size, create_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, match_id) DO UPDATE SET
         node = excluded.node,
         authoritative = excluded.authoritative,
         label = excluded.label,
         size = excluded.size`,
    )
    .bind(
      tenantId,
      record.matchId,
      uuid,
      record.node,
      record.authoritative ? 1 : 0,
      record.label,
      record.size,
      record.createTime,
    )
    .run();
}

/** 成员数变了。上游这个数是从 tracker 现算的，这里是 DO 每次 join/leave 顺手更新。 */
export async function updateMatchRecordSize(
  db: D1Database,
  tenantId: string,
  matchId: string,
  size: number,
): Promise<void> {
  await db
    .prepare("UPDATE match_record SET size = ? WHERE tenant_id = ? AND match_id = ?")
    .bind(size, tenantId, matchId)
    .run();
}

/** 只改标签（上游 `UpdateMatchLabel`）。找不到行就什么也不做。 */
export async function updateMatchRecordLabel(
  db: D1Database,
  tenantId: string,
  matchId: string,
  label: string,
): Promise<void> {
  await db
    .prepare("UPDATE match_record SET label = ? WHERE tenant_id = ? AND match_id = ?")
    .bind(label, tenantId, matchId)
    .run();
}

/** 对局结束（上游 `ClearMatchLabel` / 匹配器摘票之后的清理）。 */
export async function deleteMatchRecord(
  db: D1Database,
  tenantId: string,
  matchId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM match_record WHERE tenant_id = ? AND match_id = ?")
    .bind(tenantId, matchId)
    .run();
}

/**
 * 列表查询：读候选 → 交给 `listMatches` 做过滤与排序。
 *
 * 候选按 `create_time DESC, match_id ASC` 取——这与不带查询串时的最终顺序一致，
 * 所以"候选被截断"时最坏结果是"老对局没被看到"，而不会出现顺序错乱。
 */
export async function listMatchRecords(
  db: D1Database,
  tenantId: string,
  filters: MatchListFilters,
): Promise<readonly MatchRecord[]> {
  if (filters.limit === 0) return [];
  const rows = await db
    .prepare(
      `SELECT match_id, node, authoritative, label, size, create_time
         FROM match_record
        WHERE tenant_id = ?
        ORDER BY create_time DESC, match_id ASC
        LIMIT ?`,
    )
    .bind(tenantId, LISTING_SCAN_CAP)
    .all<RecordRow>();
  const records = (rows.results ?? []).map(
    (row): MatchRecord => ({
      matchId: row.match_id,
      node: row.node,
      authoritative: row.authoritative !== 0,
      label: row.label,
      size: row.size,
      createTime: row.create_time,
    }),
  );
  return listMatches(records, filters);
}
