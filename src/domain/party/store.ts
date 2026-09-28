/**
 * 派对目录的存储层：`party_record` 表（D1）。
 *
 * 谁写这张表：**派对 DO**。创建、标签/开放位更新、关闭各写一次，于是列表端点只需要
 * 读一张表；上游是 bluge 内存索引 + 定时批量刷（`LabelUpdateIntervalMs`），
 * 两条路各有各的坑（索引重建、批量刷的延迟窗口）。合并成一条同步写路径是本项目的
 * 形态差异，记在 ECN-0013 偏差 2。
 *
 * 隐藏派对**不进目录**这件事在 SQL 里（`hidden = 0`），不靠领域层再判一次：
 * 这样"目录里看不到隐藏派对"是一条可以直接对着库验的事实。
 *
 * 契约源（机器可读）：
 * 契约源: server/party_registry.go::LocalPartyRegistry.PartyList
 * 契约源: server/party_registry.go::MapPartyIndexEntry
 *
 * REQ-0001-019
 */

import { listParties, PARTY_LISTING_SCAN_CAP } from "./catalog";
import type { PartyListFilters, PartyListPage, PartyRecord } from "./types";

interface RecordRow {
  readonly party_id: string;
  readonly uuid: string;
  readonly node: string;
  readonly open: number;
  readonly hidden: number;
  readonly max_size: number;
  readonly label: string;
  readonly create_time: number;
  readonly [column: string]: SqlStorageValue;
}

export async function upsertPartyRecord(
  db: D1Database,
  tenantId: string,
  record: PartyRecord,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO party_record
         (tenant_id, party_id, uuid, node, open, hidden, max_size, label, create_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, party_id) DO UPDATE SET
         open = excluded.open,
         hidden = excluded.hidden,
         max_size = excluded.max_size,
         label = excluded.label`,
    )
    .bind(
      tenantId,
      record.partyId,
      record.uuid,
      record.node,
      record.open ? 1 : 0,
      record.hidden ? 1 : 0,
      record.maxSize,
      record.label,
      record.createTime,
    )
    .run();
}

export async function deletePartyRecord(
  db: D1Database,
  tenantId: string,
  partyId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM party_record WHERE tenant_id = ? AND party_id = ?")
    .bind(tenantId, partyId)
    .run();
}

/**
 * 列表查询：读候选 → 交给 `listParties` 做过滤、排序、翻页。
 *
 * 候选按 `create_time DESC, party_id ASC` 取，与最终顺序一致，所以候选被上限截断时
 * 最坏结果是"更老的派对没被看到"，不会出现顺序错乱。
 */
export async function listPartyRecords(
  db: D1Database,
  tenantId: string,
  filters: PartyListFilters,
): Promise<PartyListPage> {
  if (filters.limit === 0) return { parties: [], cursor: "" };
  const rows = await db
    .prepare(
      `SELECT party_id, uuid, node, open, hidden, max_size, label, create_time
         FROM party_record
        WHERE tenant_id = ? AND hidden = 0
        ORDER BY create_time DESC, party_id ASC
        LIMIT ?`,
    )
    .bind(tenantId, PARTY_LISTING_SCAN_CAP)
    .all<RecordRow>();
  const records = (rows.results ?? []).map(
    (row): PartyRecord => ({
      partyId: row.party_id,
      uuid: row.uuid,
      node: row.node,
      open: row.open !== 0,
      hidden: row.hidden !== 0,
      maxSize: row.max_size,
      label: row.label,
      createTime: row.create_time,
    }),
  );
  return listParties(records, filters);
}
