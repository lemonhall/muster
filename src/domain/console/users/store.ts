/**
 * 控制台用户的 D1 访问层。
 *
 * 这一层只做三件事：拼 SQL、把行翻译成记录、以及**把 D1 的写冲突翻译成可重试信号**。
 * 授权规则一条都不在这里——那是 `policy.ts` 与 `service.ts` 的事。这样切分的原因
 * 很实际：`TestAddUserRejectsInvalidACLBeforeSideEffects` 要证明"拒绝发生在写之前"，
 * 而"写"必须是可数的，所以它只能有一个入口。
 *
 * 与上游的形态差异（ECN-0014 偏差 3）：上游用 `SELECT ... FOR UPDATE` 锁住目标行，
 * 这里没有行锁可选，改用 `UPDATE ... RETURNING`——**"写回了几行"本身就是授权与存在性
 * 的最终裁判**：返回 0 行就是"目标不在了"，调用方据此报 `NotFound`。
 *
 * 契约源（机器可读）：
 * 契约源: server/console_user.go::dbInsertConsoleUser
 * 契约源: server/console_user.go::dbListConsoleUsers
 *
 * REQ-0001-021
 */

import type {
  ConsoleAuditEntry,
  ConsoleUserRecord,
  ConsoleUserStore,
  NewConsoleUser,
  PasswordPatch,
} from "./service";

const CONSOLE_USER_COLUMNS =
  "id, username, email, acl, mfa_required, mfa_enabled, create_time, update_time";

interface ConsoleUserRow {
  readonly id: string;
  readonly username: string;
  readonly email: string;
  readonly acl: string;
  readonly mfa_required: number;
  readonly mfa_enabled: number;
  readonly create_time: number;
  readonly update_time: number;
}

function toRecord(row: ConsoleUserRow): ConsoleUserRecord {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    aclJson: row.acl,
    mfaRequired: row.mfa_required !== 0,
    mfaEnabled: row.mfa_enabled !== 0,
    createTime: row.create_time,
    updateTime: row.update_time,
    // 上游 `create_time != update_time AS updated`：同一个表达式，同一条语义。
    updated: row.create_time !== row.update_time,
  };
}

/** 上游 `dbInsertConsoleUser` 的 upsert：用户名冲突就改权限与 MFA 要求。 */
async function insertUser(
  db: D1Database,
  tenantId: string,
  user: NewConsoleUser,
): Promise<ConsoleUserRecord> {
  const row = await db
    .prepare(
      `INSERT INTO console_user (tenant_id, id, username, email, acl, mfa_required, create_time, update_time)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
       ON CONFLICT (tenant_id, username) DO UPDATE SET
         acl = ?5, mfa_required = ?6, update_time = ?7
       RETURNING ${CONSOLE_USER_COLUMNS}`,
    )
    .bind(
      tenantId,
      user.id,
      user.username,
      user.email,
      user.aclJson,
      user.mfaRequired ? 1 : 0,
      user.now,
    )
    .first<ConsoleUserRow>();
  if (row === null) throw new Error("console user upsert returned no row");
  return toRecord(row);
}

async function listUsers(db: D1Database, tenantId: string): Promise<readonly ConsoleUserRecord[]> {
  const result = await db
    .prepare(
      `SELECT ${CONSOLE_USER_COLUMNS} FROM console_user WHERE tenant_id = ?1 ORDER BY username`,
    )
    .bind(tenantId)
    .all<ConsoleUserRow>();
  return result.results.map(toRecord);
}

async function readUserAcl(db: D1Database, tenantId: string, username: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT acl FROM console_user WHERE tenant_id = ?1 AND username = ?2")
    .bind(tenantId, username)
    .first<{ readonly acl: string }>();
  return row === null ? null : row.acl;
}

/**
 * 写回临时口令与一次性 code。
 *
 * `RETURNING id` 是刻意的：调用方用"有没有返回行"判断目标是否还在，
 * 而不是先 SELECT 一次再 UPDATE——那两次之间正好是上游用行锁堵住的那个窗口。
 */
async function updatePassword(
  db: D1Database,
  tenantId: string,
  username: string,
  patch: PasswordPatch,
  now: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE console_user
       SET password = ?1, password_code = ?2, password_code_expiry = ?3, update_time = ?4
       WHERE tenant_id = ?5 AND username = ?6
       RETURNING id`,
    )
    .bind(patch.passwordHash, patch.codeHash, patch.codeExpiry, now, tenantId, username)
    .first<{ readonly id: string }>();
  return row !== null;
}

async function writeAudit(
  db: D1Database,
  tenantId: string,
  entry: ConsoleAuditEntry,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO console_audit (tenant_id, id, action, message, metadata, create_time)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(tenantId, crypto.randomUUID(), entry.action, entry.message, entry.metadata, entry.now)
    .run();
}

/** 把 D1 的写冲突翻译成可重试信号（Postgres 的 serialization failure 在这里的等价物）。 */
export function isRetryableD1Error(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("SQLITE_BUSY") || message.includes("database is locked");
}

/**
 * 只写一次性 code。
 *
 * 与 `updatePassword` 分成两条 SQL 而不是"一条带默认空口令的更新"：
 * 重新发邀请**不能**把已经设好的口令清掉（上游的 upsert 同样不动 `password` 列）。
 */
async function setInviteCode(
  db: D1Database,
  tenantId: string,
  username: string,
  codeHash: string,
  codeExpiry: number,
  now: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE console_user
       SET password_code = ?1, password_code_expiry = ?2, update_time = ?3
       WHERE tenant_id = ?4 AND username = ?5
       RETURNING id`,
    )
    .bind(codeHash, codeExpiry, now, tenantId, username)
    .first<{ readonly id: string }>();
  return row !== null;
}

export function d1ConsoleUserStore(db: D1Database, tenantId: string): ConsoleUserStore {
  return {
    insertUser: (user) => insertUser(db, tenantId, user),
    listUsers: () => listUsers(db, tenantId),
    readUserAcl: (username) => readUserAcl(db, tenantId, username),
    updatePassword: (username, patch, now) => updatePassword(db, tenantId, username, patch, now),
    setInviteCode: (username, codeHash, codeExpiry, now) =>
      setInviteCode(db, tenantId, username, codeHash, codeExpiry, now),
    writeAudit: (entry) => writeAudit(db, tenantId, entry),
  };
}

/** 审计行（管理操作留痕）：M9 的端点在成功之后各写一行。 */
export interface ConsoleAuditRow {
  readonly id: string;
  readonly action: string;
  readonly message: string;
  readonly metadata: string;
  readonly create_time: number;
}

export async function selectConsoleAudit(
  db: D1Database,
  tenantId: string,
): Promise<ConsoleAuditRow[]> {
  const result = await db
    .prepare(
      `SELECT id, action, message, metadata, create_time FROM console_audit
       WHERE tenant_id = ?1 ORDER BY create_time DESC, id DESC`,
    )
    .bind(tenantId)
    .all<ConsoleAuditRow>();
  return result.results;
}
