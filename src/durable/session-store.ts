/**
 * 会话注册表的存储层：`sessions` 与 `follows` 两张表，以及全部 SQL。
 *
 * 为什么要从 DO 里单独拆出来："存在哪里"和"谁该收到事件"是两件事。前者是纯 SQL
 * （能单独读、单独改、单独测），后者才是与上游 `tracker` / `statusRegistry` 对齐的
 * 语义。DO 那边因此只剩下路由与分发。
 *
 * 两张表的含义：
 * - `sessions`：一条在线会话。`has_status = 1` 表示它在 status stream 上有 presence
 *   （只有上游 `status=true` 的连接会被 Track 到该 stream）；`last_seen` 供兜底巡检用。
 * - `follows`：`session_id` 关注 `user_id`。握手时会话会关注**自己**（原因见
 *   `session-registry.ts`），所以这不能当成"纯用户维度的订阅表"来读。
 */

export interface SessionRow {
  readonly session_id: string;
  readonly user_id: string;
  readonly username: string;
  readonly status: string;
  readonly has_status: number;
  readonly last_seen: number;
  readonly [column: string]: SqlStorageValue;
}

interface FollowRow {
  readonly session_id: string;
  readonly [column: string]: SqlStorageValue;
}

export class SessionStore {
  constructor(private readonly sql: SqlStorage) {}

  migrate(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS sessions (
         session_id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL,
         username TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT '',
         has_status INTEGER NOT NULL DEFAULT 0,
         last_seen INTEGER NOT NULL
       );
       CREATE TABLE IF NOT EXISTS follows (
         session_id TEXT NOT NULL,
         user_id TEXT NOT NULL,
         PRIMARY KEY (session_id, user_id)
       );
       CREATE INDEX IF NOT EXISTS follows_by_user ON follows(user_id);`,
    );
  }

  upsert(
    sessionId: string,
    userId: string,
    username: string,
    hasStatus: number,
    status: string,
  ): void {
    this.sql.exec(
      `INSERT INTO sessions (session_id, user_id, username, status, has_status, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         user_id = excluded.user_id,
         username = excluded.username,
         status = excluded.status,
         has_status = excluded.has_status,
         last_seen = excluded.last_seen`,
      sessionId,
      userId,
      username,
      status,
      hasStatus,
      Date.now(),
    );
  }

  find(sessionId: string): SessionRow | undefined {
    return this.sql
      .exec<SessionRow>("SELECT * FROM sessions WHERE session_id = ?", sessionId)
      .toArray()[0];
  }

  /** 某个用户当前**所有**在线会话。同一用户开两条连接就有两行（上游行为）。 */
  listByUser(userId: string): SessionRow[] {
    return this.sql
      .exec<SessionRow>(
        "SELECT * FROM sessions WHERE user_id = ? AND has_status = 1 ORDER BY session_id",
        userId,
      )
      .toArray();
  }

  /** 关注了某用户的会话 id 列表。 */
  followersOf(userId: string): string[] {
    return this.sql
      .exec<FollowRow>("SELECT session_id FROM follows WHERE user_id = ?", userId)
      .toArray()
      .map((row) => row.session_id);
  }

  /**
   * 巡检用：这些会话 id 里，当前**还在注册表里**的那些。
   *
   * 注册表是"谁在线"的唯一判据（心跳 + 超时驱逐），所以频道 DO 的兜底巡检来问这一句，
   * 而不是自己养第二套心跳（见 `channel-core.ts::sweep`）。
   */
  aliveAmong(sessionIds: readonly string[]): string[] {
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => "?").join(", ");
    return this.sql
      .exec<SessionRow>(
        `SELECT * FROM sessions WHERE session_id IN (${placeholders}) ORDER BY session_id`,
        ...sessionIds,
      )
      .toArray()
      .map((row) => row.session_id);
  }

  /**
   * 这批用户里当前**在线**的那些（与上游 `FillOnlineUsers` 同义）。
   *
   * 判据是"该用户在 status stream 上有 presence"，也就是 `has_status = 1` 的会话。
   * 上游靠 `tracker.ListPresenceIDByStreams` 查同一个东西，这里用一句 SQL 表达——
   * 一个用户开两条连接也只回一次（`DISTINCT`），因为这里问的是"人在不在"。
   */
  onlineAmong(userIds: readonly string[]): string[] {
    if (userIds.length === 0) return [];
    const placeholders = userIds.map(() => "?").join(", ");
    return this.sql
      .exec<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM sessions
         WHERE has_status = 1 AND user_id IN (${placeholders})
         ORDER BY user_id`,
        ...userIds,
      )
      .toArray()
      .map((row) => row.user_id);
  }

  follow(sessionId: string, userId: string): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO follows (session_id, user_id) VALUES (?, ?)",
      sessionId,
      userId,
    );
  }

  unfollow(sessionId: string, userId: string): void {
    this.sql.exec("DELETE FROM follows WHERE session_id = ? AND user_id = ?", sessionId, userId);
  }

  /** 删会话连同它自己的全部关注关系（关注别人的和关注自己的）。 */
  remove(sessionId: string): void {
    this.sql.exec("DELETE FROM follows WHERE session_id = ?", sessionId);
    this.sql.exec("DELETE FROM sessions WHERE session_id = ?", sessionId);
  }

  touch(sessionId: string, at: number): void {
    this.sql.exec("UPDATE sessions SET last_seen = ? WHERE session_id = ?", at, sessionId);
  }

  /** 巡检用：超过 `deadline` 没露过面的会话。 */
  staleBefore(deadline: number): SessionRow[] {
    return this.sql
      .exec<SessionRow>("SELECT * FROM sessions WHERE last_seen < ?", deadline)
      .toArray();
  }
}
