/**
 * 好友边的**写**语句（读全在 `store.ts`）。
 *
 * 每一条都是上游 `core_friend.go` 里对应那一条 SQL 的等价物，包含三处必须照搬的细节：
 *
 *   1. **"刚建立"的判据是"这次写入改到了两行"**。上游靠 `RowsAffected == 2` 区分
 *      "新关系"与"关系早就有/被对方拉黑了"，本项目也以 `meta.changes` 为唯一判据——
 *      不用额外的 SELECT 猜，因为那中间存在竞态。
 *   2. **接受邀请与新建邀请是同一次写入的两个分支**（先 UPDATE，改不到两行才 INSERT）。
 *      上游如此，因为"对方已经邀请过我"和"我首次发出邀请"共用同一组边。
 *   3. **对方拉黑我时不能建边**：INSERT 的 `WHERE NOT EXISTS (... state = 3)` 就是这条。
 *
 * 一处刻意的实现差异：上游把"一次请求里的所有好友"包在一个事务里，本项目受 D1 限制
 * 只能做到**每个好友一个原子批次**（`batch` 是 D1 的事务边界）。可观测后果只在
 * "第 N 个好友写库失败"时出现，已登记在 [ECN-0008](../../../docs/ecn/ECN-0008-social-graph-on-d1.md)。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_friend.go::addFriend
 * 契约源: server/core_friend.go::deleteFriend
 * 契约源: server/core_friend.go::blockFriend
 *
 * REQ-0001-011
 */

/**
 * "接受好友邀请"：把两个方向上的邀请边一起改成 `FRIEND`。
 *
 * metadata 的合并用 `json_patch`：上游是 Postgres 的 `jsonb || jsonb`（右值优先）。
 */
export function acceptInvite(
  db: D1Database,
  tenantId: string,
  userId: string,
  friendId: string,
  metadata: string,
  now: number,
): Promise<D1Result> {
  return db
    .prepare(
      `UPDATE user_edge SET state = 0, update_time = ?3,
         metadata = CASE
           WHEN source_id = ?1 AND destination_id = ?2 THEN json_patch(metadata, ?4)
           ELSE metadata
         END
       WHERE tenant_id = ?5
         AND ((source_id = ?2 AND destination_id = ?1 AND state = 1)
           OR (source_id = ?1 AND destination_id = ?2 AND state = 2))`,
    )
    .bind(userId, friendId, now, metadata, tenantId)
    .run();
}

/**
 * 新邀请：一次 batch 写两行（同一个 position，与上游的两行插入等价）。
 *
 * 两条 INSERT 的守卫**必须写成同一句**："目标账号存在，且目标没有拉黑我"。
 * 上游的 `WHERE` 是对两行 `VALUES` 共用的（只引用 `$1`/`$2`，不引用行自身的列），
 * 若照着"行自身"去推导，第二行会变成"我没有拉黑目标"——那会让"我拉黑过对方"
 * 时写出**一条半**的边。外层已经拦掉了那种情况，但守卫不该依赖外层的自觉。
 */
export function insertInvitePair(
  db: D1Database,
  tenantId: string,
  userId: string,
  friendId: string,
  position: number,
  metadata: string,
  now: number,
): D1PreparedStatement[] {
  const guard = `WHERE EXISTS (SELECT 1 FROM users WHERE tenant_id = ?1 AND id = ?3)
         AND NOT EXISTS (SELECT 1 FROM user_edge
                         WHERE tenant_id = ?1 AND source_id = ?3 AND destination_id = ?2 AND state = 3)`;
  // ?1 租户 / ?2 调用者 / ?3 目标 / ?4 position / ?5 时间 / ?6 metadata。
  // 两条语句的**绑定个数各不相同**（第二行没有 metadata），D1 会按每条语句实际用到的
  // 最大编号来校验参数个数，所以元数据只为第一条绑定。
  const statement = (row: string, args: readonly unknown[]) =>
    db
      .prepare(
        `INSERT INTO user_edge (tenant_id, source_id, destination_id, state, position, update_time, metadata)
         SELECT ${row}
         ${guard}
         ON CONFLICT (tenant_id, source_id, destination_id) DO NOTHING`,
      )
      .bind(...args);
  return [
    statement("?1, ?2, ?3, 1, ?4, ?5, ?6", [tenantId, userId, friendId, position, now, metadata]),
    statement("?1, ?3, ?2, 2, ?4, ?5, '{}'", [tenantId, userId, friendId, position, now]),
  ];
}

/**
 * 关系刚建立时把双方的 `edge_count` 各加一。
 *
 * 判定条件是"库里存在 position = ? 的那对边"——这正是上游的写法：只有当两条边都是
 * **同一次插入**建出来的时候才该加计数（重复加好友不重复计数）。
 */
export function bumpEdgeCountsForNewPair(
  db: D1Database,
  tenantId: string,
  userId: string,
  friendId: string,
  position: number,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE users SET edge_count = edge_count + 1, update_time = ?5
       WHERE tenant_id = ?1 AND (id = ?2 OR id = ?3)
         AND EXISTS (SELECT 1 FROM user_edge
                     WHERE tenant_id = ?1 AND position = ?4
                       AND ((source_id = ?2 AND destination_id = ?3)
                         OR (source_id = ?3 AND destination_id = ?2)))`,
    )
    .bind(tenantId, userId, friendId, position, now);
}

/**
 * 删边：自己的那条边无条件删，对方那条边**只删非拉黑**的。
 *
 * 这条不对称是上游 `deleteFriend` 的原话——"删除好友"不应该顺手解除对方给我的拉黑。
 */
export function deleteEdges(
  db: D1Database,
  tenantId: string,
  userId: string,
  friendId: string,
): Promise<D1Result> {
  return db
    .prepare(
      `DELETE FROM user_edge
       WHERE tenant_id = ?3
         AND ((source_id = ?1 AND destination_id = ?2)
           OR (source_id = ?2 AND destination_id = ?1 AND state <> 3))`,
    )
    .bind(userId, friendId, tenantId)
    .run();
}

/** 我的那条边改成 `BLOCKED`（存在就改，不存在就忽略，由调用方决定要不要补插）。 */
export function markBlocked(
  db: D1Database,
  tenantId: string,
  userId: string,
  friendId: string,
  now: number,
): Promise<D1Result> {
  return db
    .prepare(
      `UPDATE user_edge SET state = 3, update_time = ?3
       WHERE tenant_id = ?4 AND source_id = ?1 AND destination_id = ?2`,
    )
    .bind(userId, friendId, now, tenantId)
    .run();
}

/** 没有任何边时补一条 `BLOCKED`；目标账号不存在则一行都不写（上游同款守卫）。 */
export function insertBlocked(
  db: D1Database,
  tenantId: string,
  userId: string,
  friendId: string,
  position: number,
  now: number,
): Promise<D1Result> {
  return db
    .prepare(
      `INSERT INTO user_edge (tenant_id, source_id, destination_id, state, position, update_time, metadata)
       SELECT ?1, ?2, ?3, 3, ?4, ?5, '{}'
       WHERE EXISTS (SELECT 1 FROM users WHERE tenant_id = ?1 AND id = ?3)
         AND NOT EXISTS (SELECT 1 FROM user_edge
                         WHERE tenant_id = ?1 AND source_id = ?2 AND destination_id = ?3)`,
    )
    .bind(tenantId, userId, friendId, position, now)
    .run();
}

/** 删掉**被拉黑者**朝向我的那条非拉黑边（对方也拉黑我时保留他那一行）。 */
export function deleteOppositeEdge(
  db: D1Database,
  tenantId: string,
  userId: string,
  friendId: string,
): Promise<D1Result> {
  return db
    .prepare(
      `DELETE FROM user_edge
       WHERE tenant_id = ?3 AND source_id = ?2 AND destination_id = ?1 AND state <> 3`,
    )
    .bind(userId, friendId, tenantId)
    .run();
}

/** `edge_count` 增减。`delta` 只有两个取值，SQL 片段由它二选一，不拼接外部输入。 */
export function bumpEdgeCount(
  db: D1Database,
  tenantId: string,
  userIds: readonly string[],
  delta: 1 | -1,
  now: number,
): D1PreparedStatement {
  const placeholders = userIds.map((_, index) => `?${index + 2}`).join(", ");
  return db
    .prepare(
      `UPDATE users SET edge_count = edge_count ${delta > 0 ? "+" : "-"} 1, update_time = ?${userIds.length + 2}
       WHERE tenant_id = ?1 AND id IN (${placeholders})`,
    )
    .bind(tenantId, ...userIds, now);
}
