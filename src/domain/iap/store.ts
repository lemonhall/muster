/**
 * 已校验交易的落库层（`purchase` 表，见 `migrations/0008_iap.sql`）。
 *
 * 与上游 `server/core_purchase.go::upsertPurchases` 的两点差异，都是为了"可观测值正确"：
 *
 *   1. **`seen_before` 是行上的一个显式列**，不是在读的时候用
 *      `update_time > create_time` 反推。上游那样推在同精度只有秒、或"同一秒内二次校验"
 *      的场合会退化成 false；本项目把它写成列，于是"这条收据我见过"永远说得准。
 *   2. **冲突时不覆盖 `refund_time`**：退款状态由退款通知推进，不该被一次重放的传统
 *      收据校验抹回去（上游在传统路径上会把 `EXCLUDED.refund_time` 写回去，而那里恒为
 *      epoch 0）。
 *
 * 主键是多租户的 `(tenant_id, id)`；冲突判定走 `(tenant_id, store, transaction_id)`
 * ——交易号只在**同一商店内**唯一，而租户之间必须互不可见（ECN-0001）。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_purchase.go::upsertPurchases
 *
 * REQ-0001-022
 */

export interface NewPurchaseRow {
  readonly userId: string;
  readonly productId: string;
  readonly transactionId: string;
  readonly purchaseTimeSec: number;
  readonly environment: number;
  readonly rawResponse: string;
}

export interface StoredPurchaseRow extends NewPurchaseRow {
  readonly store: number;
  readonly createTimeSec: number;
  readonly updateTimeSec: number;
  readonly seenBefore: boolean;
}

interface RawRow {
  readonly user_id: string;
  readonly store: number;
  readonly product_id: string;
  readonly transaction_id: string;
  readonly purchase_time: number;
  readonly environment: number;
  readonly raw_response: string;
  readonly seen_before: number;
  readonly create_time: number;
  readonly update_time: number;
}

const UPSERT = `
INSERT INTO purchase
  (tenant_id, id, user_id, store, product_id, transaction_id, purchase_time, refund_time,
   environment, raw_response, seen_before, create_time, update_time)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, 0, ?10, ?10)
ON CONFLICT (tenant_id, store, transaction_id) DO UPDATE SET
  seen_before = 1,
  update_time = excluded.update_time
RETURNING user_id, store, product_id, transaction_id, purchase_time, environment, raw_response,
          seen_before, create_time, update_time
`;

function toStored(row: RawRow): StoredPurchaseRow {
  return {
    userId: row.user_id,
    store: row.store,
    productId: row.product_id,
    transactionId: row.transaction_id,
    purchaseTimeSec: row.purchase_time,
    environment: row.environment,
    rawResponse: row.raw_response,
    createTimeSec: row.create_time,
    updateTimeSec: row.update_time,
    seenBefore: row.seen_before === 1,
  };
}

/**
 * 批量 upsert。整批在一个 `batch` 里发出去（D1 的 batch 是事务语义），
 * 于是"一次校验里的多笔交易"要么都落、要么都不落。
 */
export async function upsertPurchases(
  db: D1Database,
  tenantId: string,
  store: number,
  rows: readonly NewPurchaseRow[],
  nowSec: number,
): Promise<StoredPurchaseRow[]> {
  if (rows.length === 0) return [];
  const statements = rows.map((row) =>
    db
      .prepare(UPSERT)
      .bind(
        tenantId,
        crypto.randomUUID(),
        row.userId,
        store,
        row.productId,
        row.transactionId,
        row.purchaseTimeSec,
        row.environment,
        row.rawResponse,
        nowSec,
      ),
  );
  const results = await db.batch(statements);
  return results.flatMap((result) => (result.results as RawRow[]).map(toStored));
}
