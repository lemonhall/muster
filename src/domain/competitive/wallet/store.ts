/**
 * 钱包与账本的 D1 访问层。
 *
 * 这里最要紧的一件事是**原子性**。上游用 `SELECT ... FOR UPDATE` 把要改的行锁住，
 * 在一个事务里读完改完写完；D1 没有交互式事务（只有 `batch()`，它是一个原子批次）。
 * 所以这里换成 **CAS（比较并交换）+ 守卫语句**：
 *   1. 先读一遍钱包（拿到"我看到的旧值"）；
 *   2. 写的时候 `WHERE wallet = ?旧值`——旧值被人改过就影响 0 行；
 *   3. 每条 UPDATE 后面跟一条守卫 INSERT，`changes() = 0` 时故意违反 CHECK 约束，
 *      让**整个批次回滚**。
 * 于是"半个批次写进去"在结构上不可能发生；CAS 失败就是"我这轮读到的快照过期了"，
 * 由上层重读重算（见 service.ts 的重试循环）。差异登记在 ECN-0010 偏差 6。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_wallet.go::updateWallets
 */

export interface WalletRow {
  readonly id: string;
  readonly wallet: string;
}

export function selectWallets(
  db: D1Database,
  tenantId: string,
  userIds: readonly string[],
): Promise<D1Result<WalletRow>> {
  const params: unknown[] = [tenantId];
  const placeholders = userIds.map((id) => {
    params.push(id);
    return `?${params.length}`;
  });
  return db
    .prepare(`SELECT id, wallet FROM users WHERE tenant_id = ?1 AND id IN (${placeholders.join(", ")})`)
    .bind(...params)
    .all<WalletRow>();
}

/** 一个用户一次的落库写入（旧值用于 CAS，新值已经算好）。 */
export interface WalletWrite {
  readonly userId: string;
  readonly previousJson: string;
  readonly nextJson: string;
}

/** 一条账本行——**按调用方的每条 update 一行**，同一个用户出现多次就写多行（与上游一致）。 */
export interface LedgerWrite {
  readonly userId: string;
  readonly changesetJson: string;
  readonly metadata: string;
}

/**
 * 把一批写入展开成"一个原子批次"的语句表。
 *
 * 顺序固定：先全部 UPDATE（每条后面跟守卫），再全部账本 INSERT。这样即使守卫
 * 触发，回滚时也不会留下"有账本行、没钱包变更"的孤儿。
 */
export function buildWalletWriteStatements(
  db: D1Database,
  tenantId: string,
  now: number,
  writes: readonly WalletWrite[],
  ledger: readonly LedgerWrite[],
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const write of writes) {
    statements.push(
      db
        .prepare(
          `UPDATE users SET wallet = ?1, update_time = ?2
           WHERE tenant_id = ?3 AND id = ?4 AND wallet = ?5`,
        )
        .bind(write.nextJson, now, tenantId, write.userId, write.previousJson),
      // 守卫：上一条 UPDATE 一行都没改到，就让整个批次失败（CHECK 约束违反）。
      db.prepare("INSERT INTO write_guard (ok) SELECT 0 WHERE (SELECT changes()) = 0"),
    );
  }
  for (const entry of ledger) {
    statements.push(
      db
        .prepare(
          `INSERT INTO wallet_ledger (tenant_id, id, user_id, changeset, metadata, create_time, update_time)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
        )
        .bind(
          tenantId,
          crypto.randomUUID(),
          entry.userId,
          entry.changesetJson,
          entry.metadata === "" ? "{}" : entry.metadata,
          now,
        ),
    );
  }
  return statements;
}

export interface WalletLedgerListRow {
  readonly id: string;
  readonly changeset: string;
  readonly metadata: string;
  readonly create_time: number;
  readonly update_time: number;
}

export interface LedgerCursor {
  readonly userId: string;
  readonly createTime: number;
  readonly id: string;
  readonly isNext: boolean;
}

/**
 * 账本列表。上游的游标是元组 `(user_id, create_time, id)`，方向由 `isNext` 决定：
 *   - 往下翻：`(...) < (游标)` 且 `ORDER BY create_time DESC`；
 *   - 往上翻：`(...) > (游标)` 且 `ORDER BY create_time ASC`，取完再由调用方反转。
 * `after` / `before` 是额外的时间窗过滤。
 */
export async function selectWalletLedger(
  db: D1Database,
  tenantId: string,
  userId: string,
  options: {
    readonly limit: number | null;
    readonly cursor: LedgerCursor | null;
    readonly after: number;
    readonly before: number;
    /** 当前时刻（秒）：没有游标时上游用 `(create_time, id) < (now, "")` 挡住未来行。 */
    readonly now: number;
  },
): Promise<WalletLedgerListRow[]> {
  const params: unknown[] = [tenantId, userId];
  const push = (value: unknown): number => {
    params.push(value);
    return params.length;
  };
  const backwards = options.cursor !== null && !options.cursor.isNext;
  const comparison = backwards ? ">" : "<";
  let sql =
    "SELECT id, changeset, metadata, create_time, update_time FROM wallet_ledger WHERE tenant_id = ?1 AND user_id = ?2";
  if (options.cursor === null) {
    // 上游拿"当前时间 + 空 UUID"当界：`(create_time, id) < (now, "")`。
    // id 永远非空，所以这等价于 `create_time <= now`。
    sql += ` AND create_time <= ?${push(options.now)}`;
  } else {
    const first = push(options.cursor.createTime);
    const second = push(options.cursor.id);
    sql += ` AND (user_id, create_time, id) ${comparison} (?2, ?${first}, ?${second})`;
  }
  if (options.after !== 0) sql += ` AND create_time > ?${push(options.after)}`;
  if (options.before !== 0) sql += ` AND create_time < ?${push(options.before)}`;
  sql += backwards ? " ORDER BY create_time ASC, id ASC" : " ORDER BY create_time DESC, id DESC";
  if (options.limit !== null) sql += ` LIMIT ?${push(options.limit + 1)}`;
  const result = await db.prepare(sql).bind(...params).all<WalletLedgerListRow>();
  return result.results;
}

/** 账本单行更新：`metadata = metadata || $2`（JSON 对象合并）。 */
export async function updateWalletLedgerRow(
  db: D1Database,
  tenantId: string,
  ledgerId: string,
  metadata: string,
  now: number,
): Promise<WalletLedgerListRow | null> {
  return db
    .prepare(
      `UPDATE wallet_ledger
       SET update_time = ?1, metadata = json_patch(metadata, ?2)
       WHERE tenant_id = ?3 AND id = ?4
       RETURNING id, changeset, metadata, create_time, update_time`,
    )
    .bind(now, metadata, tenantId, ledgerId)
    .first<WalletLedgerListRow>();
}
