/**
 * 频道 DO 的成员表：谁在这个频道里、以什么姿态在。
 *
 * 逐条对齐上游 tracker（`server/tracker.go`）里与频道有关的三个事实：
 *
 * 1. **成员的身份是 (session_id, user_id)**：上游 `presenceCompact` 由
 *    (节点, 会话, 流, 用户) 组成，而本项目"节点"恒为本 DO，所以主键就是这两列。
 *    于是同一条连接重复 join 同一个频道 = `isNew:false`（上游 `Track` 的
 *    `alreadyTracked` 早返回），**meta 不会被第二次 join 覆盖**——这一点很反直觉，
 *    但它决定了"先 hidden 再加入"与"先加入再 hidden"的结果不同，必须照抄。
 * 2. **hidden 成员不进快照、不产生 presence 事件**：上游 `ListByStream(stream,false,true)`
 *    与 `queueEvent` 的守卫都跳过 hidden；但它**照收消息**（`ListPresenceIDByStream`
 *    不过滤 hidden）。所以"可见性"只作用于 presence，不作用于投递。
 * 3. **persistence 是每条 presence 自己的**（上游 `PresenceMeta.Persistence` 来自
 *    发起 join 的那条连接），不是频道的属性。"谁能让消息落盘"因此是**发送者**说了算。
 *
 * 快照顺序：上游 `ListByStream` 遍历 Go map，顺序**未定义**；这里按 `joined_at, session_id`
 * 排序，把一个未定义顺序变成确定顺序（客户端本来就不该依赖它）。
 *
 * 契约源（机器可读）：
 * 契约源: server/tracker.go::LocalTracker.Track
 * 契约源: server/tracker.go::LocalTracker.Untrack
 * 契约源: server/tracker.go::LocalTracker.ListByStream
 * 契约源: server/tracker.go::LocalTracker.ListPresenceIDByStream
 *
 * REQ-0001-010
 */

export interface MemberRow {
  readonly session_id: string;
  readonly user_id: string;
  readonly username: string;
  readonly persistence: number;
  readonly hidden: number;
  readonly joined_at: number;
  readonly [column: string]: SqlStorageValue;
}

export interface TrackInput {
  readonly sessionId: string;
  readonly userId: string;
  readonly username: string;
  readonly persistence: boolean;
  readonly hidden: boolean;
}

export class ChannelMembers {
  constructor(private readonly sql: SqlStorage) {}

  migrate(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS members (
         session_id TEXT NOT NULL,
         user_id TEXT NOT NULL,
         username TEXT NOT NULL,
         persistence INTEGER NOT NULL,
         hidden INTEGER NOT NULL,
         joined_at INTEGER NOT NULL,
         PRIMARY KEY (session_id, user_id)
       );`,
    );
  }

  find(sessionId: string, userId: string): MemberRow | undefined {
    return this.sql
      .exec<MemberRow>(
        "SELECT * FROM members WHERE session_id = ? AND user_id = ?",
        sessionId,
        userId,
      )
      .toArray()[0];
  }

  /** 上游 `Track` 的返回值：`isNew` 为 false 时**什么也不改**（不更新 meta、不发事件）。 */
  track(input: TrackInput, at: number): { readonly isNew: boolean } {
    if (this.find(input.sessionId, input.userId) !== undefined) return { isNew: false };
    this.sql.exec(
      `INSERT INTO members (session_id, user_id, username, persistence, hidden, joined_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.sessionId,
      input.userId,
      input.username,
      input.persistence ? 1 : 0,
      input.hidden ? 1 : 0,
      at,
    );
    return { isNew: true };
  }

  /** 上游 `Untrack`：返回被摘掉的 presence（调用方据此决定要不要发 leave）。 */
  untrack(sessionId: string, userId: string): MemberRow | undefined {
    const row = this.find(sessionId, userId);
    if (row === undefined) return undefined;
    this.sql.exec(
      "DELETE FROM members WHERE session_id = ? AND user_id = ?",
      sessionId,
      userId,
    );
    return row;
  }

  /** 上游 `UntrackAll(sessionID)`：一条会话在这个频道里的全部 presence 一起摘掉。 */
  untrackSession(sessionId: string): MemberRow[] {
    return this.sql
      .exec<MemberRow>("DELETE FROM members WHERE session_id = ? RETURNING *", sessionId)
      .toArray();
  }

  /** 快照用：不含 hidden。 */
  visible(): MemberRow[] {
    return this.sql
      .exec<MemberRow>("SELECT * FROM members WHERE hidden = 0 ORDER BY joined_at, session_id")
      .toArray();
  }

  /** 投递用：含 hidden（上游 `ListPresenceIDByStream` 不过滤）。 */
  sessions(): string[] {
    return this.sql
      .exec<{ readonly session_id: string; readonly [column: string]: SqlStorageValue }>(
        "SELECT session_id FROM members ORDER BY session_id",
      )
      .toArray()
      .map((row) => row.session_id);
  }

  count(): number {
    const row = this.sql
      .exec<{ readonly total: number; readonly [column: string]: SqlStorageValue }>(
        "SELECT COUNT(*) AS total FROM members",
      )
      .toArray()[0];
    return row?.total ?? 0;
  }

  /**
   * 某个用户在这个频道里的全部会话。
   *
   * 它服务的是"把某人踢出这个频道"这一类操作（群组被踢/被封禁/自己退群）：上游
   * `tracker.ListByStream` 按 stream 列出 presence 再逐个 `UserLeave`，本项目按
   * **用户**找会话（一个用户可能开了多条连接），所以这里是 `WHERE user_id = ?`。
   */
  sessionsOfUser(userId: string): string[] {
    return this.sql
      .exec<{ readonly session_id: string; readonly [column: string]: SqlStorageValue }>(
        "SELECT session_id FROM members WHERE user_id = ? ORDER BY session_id",
        userId,
      )
      .toArray()
      .map((row) => row.session_id);
  }

  /** 巡检：把这些会话的成员资格全部摘掉，返回被摘掉的可见成员（要补 leave 的那些）。 */
  dropSessions(sessionIds: readonly string[]): MemberRow[] {
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => "?").join(", ");
    return this.sql
      .exec<MemberRow>(
        `DELETE FROM members WHERE session_id IN (${placeholders}) RETURNING *`,
        ...sessionIds,
      )
      .toArray();
  }
}
