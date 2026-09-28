/**
 * 身份/账号/会话的 D1 访问层。
 *
 * 纪律：**每一条 SQL 都带 `tenant_id` 条件**。租户隔离不是"记得加 where"的约定，
 * 而是这一层的唯一入口形态——上层拿不到不带租户的查询方法。
 */

export interface UserRow {
  readonly tenant_id: string;
  readonly id: string;
  readonly username: string;
  readonly display_name: string;
  readonly avatar_url: string;
  readonly lang_tag: string;
  readonly location: string;
  readonly timezone: string;
  readonly metadata: string;
  readonly email: string | null;
  readonly password_hash: string | null;
  readonly verify_time: number;
  readonly disable_time: number;
  readonly create_time: number;
  readonly update_time: number;
}

export interface SessionRow {
  readonly token_id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly exp: number;
  readonly refresh_exp: number;
  readonly created_at: number;
  readonly revoked_at: number;
}

export interface IdentityRow {
  readonly provider: string;
  readonly provider_id: string;
  readonly user_id: string;
}

const USER_COLUMNS = [
  "tenant_id",
  "id",
  "username",
  "display_name",
  "avatar_url",
  "lang_tag",
  "location",
  "timezone",
  "metadata",
  "email",
  "password_hash",
  "verify_time",
  "disable_time",
  "create_time",
  "update_time",
].join(", ");

export function findUserByUsername(db: D1Database, tenantId: string, username: string): Promise<UserRow | null> {
  return db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE tenant_id = ?1 AND username = ?2`)
    .bind(tenantId, username)
    .first<UserRow>();
}

export function findUserByEmail(db: D1Database, tenantId: string, email: string): Promise<UserRow | null> {
  return db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE tenant_id = ?1 AND email = ?2`)
    .bind(tenantId, email)
    .first<UserRow>();
}

export function findUserById(db: D1Database, tenantId: string, userId: string): Promise<UserRow | null> {
  return db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE tenant_id = ?1 AND id = ?2`)
    .bind(tenantId, userId)
    .first<UserRow>();
}

function inClause(column: string, startIndex: number, values: readonly string[]): string {
  return `${column} IN (${values.map((_, offset) => `?${startIndex + offset}`).join(", ")})`;
}

export async function findUsersByIds(
  db: D1Database,
  tenantId: string,
  ids: readonly string[],
): Promise<UserRow[]> {
  if (ids.length === 0) return [];
  const result = await db
    .prepare(
      `SELECT ${USER_COLUMNS} FROM users WHERE tenant_id = ?1 AND ${inClause("id", 2, ids)} ORDER BY id`,
    )
    .bind(tenantId, ...ids)
    .all<UserRow>();
  return result.results;
}

export async function findUsersByUsernames(
  db: D1Database,
  tenantId: string,
  usernames: readonly string[],
): Promise<UserRow[]> {
  if (usernames.length === 0) return [];
  const result = await db
    .prepare(
      `SELECT ${USER_COLUMNS} FROM users WHERE tenant_id = ?1 AND ${inClause("username", 2, usernames)} ORDER BY username`,
    )
    .bind(tenantId, ...usernames)
    .all<UserRow>();
  return result.results;
}

export function findIdentity(
  db: D1Database,
  tenantId: string,
  provider: string,
  providerId: string,
): Promise<IdentityRow | null> {
  return db
    .prepare(
      "SELECT provider, provider_id, user_id FROM user_identity WHERE tenant_id = ?1 AND provider = ?2 AND provider_id = ?3",
    )
    .bind(tenantId, provider, providerId)
    .first<IdentityRow>();
}

export async function findIdentitiesForUser(
  db: D1Database,
  tenantId: string,
  userId: string,
): Promise<IdentityRow[]> {
  const result = await db
    .prepare(
      "SELECT provider, provider_id, user_id FROM user_identity WHERE tenant_id = ?1 AND user_id = ?2 ORDER BY provider, provider_id",
    )
    .bind(tenantId, userId)
    .all<IdentityRow>();
  return result.results;
}

export interface NewUser {
  readonly tenantId: string;
  readonly userId: string;
  readonly username: string;
  readonly now: number;
  readonly email?: string;
  readonly passwordHash?: string;
  /** 社交登录会把提供商给的资料写进来（Google 的名字与头像）；普通注册留空。 */
  readonly displayName?: string;
  readonly avatarUrl?: string;
}

/**
 * 建用户 + 挂身份，用一个 D1 batch（原子）完成。
 *
 * 上游用的是同一个 SQL 事务（注释原话："Create a new account and its provider link
 * together, so a failure to link cannot leave an orphaned user"）——同一个不变量：
 * 不允许出现"有用户没身份"或"有身份没用户"的中间态。
 */
export async function createUserWithIdentity(
  db: D1Database,
  input: NewUser & { readonly provider: string; readonly providerId: string },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO users (tenant_id, id, username, email, password_hash, display_name, avatar_url, create_time, update_time)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
      )
      .bind(
        input.tenantId,
        input.userId,
        input.username,
        input.email ?? null,
        input.passwordHash ?? null,
        input.displayName ?? "",
        input.avatarUrl ?? "",
        input.now,
      ),
    db
      .prepare(
        "INSERT INTO user_identity (tenant_id, provider, provider_id, user_id) VALUES (?1, ?2, ?3, ?4)",
      )
      .bind(input.tenantId, input.provider, input.providerId, input.userId),
  ]);
}

export function linkIdentity(
  db: D1Database,
  tenantId: string,
  provider: string,
  providerId: string,
  userId: string,
): Promise<D1Result> {
  return db
    .prepare("INSERT INTO user_identity (tenant_id, provider, provider_id, user_id) VALUES (?1, ?2, ?3, ?4)")
    .bind(tenantId, provider, providerId, userId)
    .run();
}

/**
 * 单独写邮箱。
 *
 * 为什么不是建号时一起写：上游对"Google 账号带回来的邮箱已经被别人用了"的处置是
 * **警告并跳过**，账号照样建；把邮箱放进建号语句会让这一条撞唯一键时连账号都建不出来。
 * 所以邮箱落库必须是建号之后的独立一步，调用方自己决定怎么吞这个冲突。
 */
export function setUserEmail(
  db: D1Database,
  tenantId: string,
  userId: string,
  email: string,
): Promise<D1Result> {
  return db
    .prepare("UPDATE users SET email = ?1 WHERE tenant_id = ?2 AND id = ?3")
    .bind(email, tenantId, userId)
    .run();
}

export interface ProfilePatch {
  readonly username?: string;
  readonly display_name?: string;
  readonly avatar_url?: string;
  readonly lang_tag?: string;
  readonly location?: string;
  readonly timezone?: string;
}

/**
 * 局部更新资料。只更新请求里真正出现的字段——上游用 `google.protobuf.StringValue`
 * 包装类型表达"这个字段出现才改"，语义与"未出现的字段保持原值"一致。
 */
export async function updateProfile(
  db: D1Database,
  tenantId: string,
  userId: string,
  patch: ProfilePatch,
  now: number,
): Promise<void> {
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [column, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    assignments.push(`${column} = ?${values.length + 1}`);
    values.push(value);
  }
  if (assignments.length === 0) return;
  assignments.push(`update_time = ?${values.length + 1}`);
  values.push(now);
  await db
    .prepare(
      `UPDATE users SET ${assignments.join(", ")} WHERE tenant_id = ?${values.length + 1} AND id = ?${values.length + 2}`,
    )
    .bind(...values, tenantId, userId)
    .run();
}

/**
 * 登记一个会话。
 *
 * `token_id` 是全局主键（对应上游 `sessionCache` 的 token 索引），但 upsert 的
 * 冲突分支**额外要求租户与用户一致**：万一真出现 token id 碰撞（122 bit 随机，
 * 概率可忽略但不为零），宁可让这条语句写成 0 行、由调用方报错，也不能把 A 游戏
 * 的会话悄悄改写成 B 游戏的会话。会话令牌的签名密钥本来就是按租户派生的，
 * 这一层是纵深防御，不是唯一防线。
 */
export async function insertSession(
  db: D1Database,
  row: { tokenId: string; tenantId: string; userId: string; exp: number; refreshExp: number; now: number },
): Promise<void> {
  const result = await db
    .prepare(
      `INSERT INTO sessions (token_id, tenant_id, user_id, exp, refresh_exp, created_at, revoked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)
       ON CONFLICT (token_id) DO UPDATE SET exp = ?4, refresh_exp = ?5, revoked_at = 0
       WHERE sessions.tenant_id = ?2 AND sessions.user_id = ?3`,
    )
    .bind(row.tokenId, row.tenantId, row.userId, row.exp, row.refreshExp, row.now)
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    throw new Error("session token id collided across tenants or users");
  }
}

/** 按 (token_id, tenant_id) 取会话：跨租户同 id 的会话在查询层就取不到。 */
export function findSession(db: D1Database, tokenId: string, tenantId: string): Promise<SessionRow | null> {
  return db
    .prepare(
      "SELECT token_id, tenant_id, user_id, exp, refresh_exp, created_at, revoked_at FROM sessions " +
        "WHERE token_id = ?1 AND tenant_id = ?2",
    )
    .bind(tokenId, tenantId)
    .first<SessionRow>();
}

/** 登出：写 revoked_at。返回受影响行数，0 表示这个 token_id 在**本租户内**不存在或已吊销。 */
export async function revokeSession(
  db: D1Database,
  tokenId: string,
  tenantId: string,
  now: number,
): Promise<number> {
  const result = await db
    .prepare("UPDATE sessions SET revoked_at = ?1 WHERE token_id = ?2 AND tenant_id = ?3 AND revoked_at = 0")
    .bind(now, tokenId, tenantId)
    .run();
  return result.meta.changes ?? 0;
}

export async function revokeSessionsForUser(
  db: D1Database,
  tenantId: string,
  userId: string,
  now: number,
): Promise<void> {
  await db
    .prepare("UPDATE sessions SET revoked_at = ?1 WHERE tenant_id = ?2 AND user_id = ?3 AND revoked_at = 0")
    .bind(now, tenantId, userId)
    .run();
}
