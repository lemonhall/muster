/**
 * 通知的 D1 访问层。
 *
 * 上游的通知表没有租户列、`create_time` 是 timestamptz（微秒精度）；这里的差异只有
 * 两条，都登记在 [ECN-0008](../../../docs/ecn/ECN-0008-social-graph-on-d1.md)：
 *   1. 多一列 `tenant_id`（多租户，ECN-0001）；
 *   2. 时间精度到**秒**，所以同一秒内的多条通知靠 `id` 决定先后。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_notification.go::NotificationList
 * 契约源: server/core_notification.go::NotificationDelete
 * 契约源: server/core_notification.go::NotificationSave
 *
 * REQ-0001-013
 */

export interface NotificationRow {
  readonly id: string;
  readonly user_id: string;
  readonly subject: string;
  readonly content: string;
  readonly code: number;
  readonly sender_id: string;
  readonly create_time: number;
}

export interface NewNotification {
  readonly id: string;
  readonly userId: string;
  readonly subject: string;
  readonly content: string;
  readonly code: number;
  readonly senderId: string;
  readonly createTime: number;
}

export function insertNotifications(
  db: D1Database,
  tenantId: string,
  rows: readonly NewNotification[],
): Promise<D1Result[]> {
  return db.batch(
    rows.map((row) =>
      db
        .prepare(
          `INSERT INTO notifications (tenant_id, id, user_id, subject, content, code, sender_id, create_time)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
        .bind(tenantId, row.id, row.userId, row.subject, row.content, row.code, row.senderId, row.createTime),
    ),
  );
}

const NOTIFICATION_COLUMNS = "id, user_id, subject, content, code, sender_id, create_time";

/**
 * 通知列表。排序与游标与上游一致：`ORDER BY create_time, id`，游标指向**下一页第一行**。
 *
 * 上游的元组比较带 `user_id` 首列（`(user_id, create_time, id) > ($1, $3, $4)`），
 * 那是为了让 Postgres 走主键索引；`user_id` 在前置 WHERE 里已经固定，语义上等价于
 * 比较 `(create_time, id)`。
 */
export async function listNotifications(
  db: D1Database,
  tenantId: string,
  userId: string,
  limit: number,
  cursor: { readonly createTime: number; readonly id: string } | null,
): Promise<NotificationRow[]> {
  const params: unknown[] = [tenantId, userId];
  let sql = `SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE tenant_id = ?1 AND user_id = ?2`;
  if (cursor !== null) {
    const first = push(params, cursor.createTime);
    const second = push(params, cursor.id);
    sql += ` AND (create_time, id) > (?${first}, ?${second})`;
  }
  sql += " ORDER BY create_time ASC, id ASC";
  if (limit > 0) sql += ` LIMIT ?${push(params, limit + 1)}`;
  const result = await db.prepare(sql).bind(...params).all<NotificationRow>();
  return result.results;
}

export async function deleteNotifications(
  db: D1Database,
  tenantId: string,
  userId: string,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const params: unknown[] = [tenantId, userId];
  const placeholders = ids.map((id) => `?${push(params, id)}`).join(", ");
  const result = await db
    .prepare(`DELETE FROM notifications WHERE tenant_id = ?1 AND user_id = ?2 AND id IN (${placeholders})`)
    .bind(...params)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * 按 id 删除，**不限定接收者**：运行时路径上（上游 `nk.notifications_delete`）
 * 调用方是平台自己，它按 id 点名删，不需要"只能删自己的"这层约束。
 *
 * 客户端那条路走上面的 `deleteNotifications`——那里的 `user_id` 过滤是权限，
 * 不是可选条件，所以两条路不能合并。
 */
export async function deleteNotificationsByIds(
  db: D1Database,
  tenantId: string,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const params: unknown[] = [tenantId];
  const placeholders = ids.map((id) => `?${push(params, id)}`).join(", ");
  const result = await db
    .prepare(`DELETE FROM notifications WHERE tenant_id = ?1 AND id IN (${placeholders})`)
    .bind(...params)
    .run();
  return result.meta.changes ?? 0;
}

function push(params: unknown[], value: unknown): number {
  params.push(value);
  return params.length;
}
