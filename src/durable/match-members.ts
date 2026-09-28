/**
 * 一个对局实例的成员表与元数据（DO 的 SQLite）。
 *
 * 上游把这两样东西放在两个地方：成员在 `MatchPresenceList`（进程内，随对局生命周期生灭），
 * 元数据（标签、tick rate、handler 名、创建时间）在 `LocalMatchRegistry` 的
 * `MatchHandler` 与 bluge 索引里。本项目把两者一起放进对局自己的 DO：
 * **一个对局的全部状态住在一个实例里**，跨请求的一致性由 DO 的单点串行化保证
 * （ECN-0011 偏差 1）。
 *
 * `label` 允许为 NULL，这不是"空标签"而是"**没有 label 字段**"——上游
 * `match_create` 与中继对局的 join 回执就是不设这个字段，客户端在 protojson 里
 * 看得见区别（有字段是 `"label":""`，没字段是根本没有这个键）。
 *
 * 契约源（机器可读）：
 * 契约源: server/match_presence.go::MatchPresenceList
 * 契约源: server/match_registry.go::LocalMatchRegistry.UpdateMatchLabel
 *
 * REQ-0001-018
 */

export interface MatchMemberRow {
  readonly session_id: string;
  readonly user_id: string;
  readonly username: string;
  readonly node: string;
  readonly joined_at: number;
  readonly [column: string]: SqlStorageValue;
}

export interface MatchMetaRow {
  readonly authoritative: number;
  /** NULL = 不带 label 字段。 */
  readonly label: string | null;
  readonly node: string;
  readonly create_time: number;
  readonly [column: string]: SqlStorageValue;
}

export class MatchMembers {
  constructor(private readonly sql: SqlStorage) {}

  migrate(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS match_member (
         session_id TEXT PRIMARY KEY,
         user_id    TEXT NOT NULL,
         username   TEXT NOT NULL,
         node       TEXT NOT NULL,
         joined_at  INTEGER NOT NULL
       );`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS match_meta (
         id            INTEGER PRIMARY KEY CHECK (id = 1),
         authoritative INTEGER NOT NULL,
         label         TEXT,
         node          TEXT NOT NULL,
         create_time   INTEGER NOT NULL
       );`,
    );
  }

  meta(): MatchMetaRow | undefined {
    const rows = this.sql
      .exec<MatchMetaRow>("SELECT authoritative, label, node, create_time FROM match_meta WHERE id = 1")
      .toArray();
    return rows[0];
  }

  setMeta(meta: MatchMetaRow): void {
    this.sql.exec(
      `INSERT INTO match_meta (id, authoritative, label, node, create_time)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         authoritative = excluded.authoritative,
         label = excluded.label,
         node = excluded.node`,
      meta.authoritative,
      meta.label,
      meta.node,
      meta.create_time,
    );
  }

  /** 顺序稳定：先来后到，同一毫秒内按会话 id —— 快照不会因为存储层而抖动。 */
  list(): readonly MatchMemberRow[] {
    return this.sql
      .exec<MatchMemberRow>(
        "SELECT session_id, user_id, username, node, joined_at FROM match_member ORDER BY joined_at, session_id",
      )
      .toArray();
  }

  find(sessionId: string): MatchMemberRow | undefined {
    const rows = this.sql
      .exec<MatchMemberRow>(
        `SELECT session_id, user_id, username, node, joined_at
           FROM match_member WHERE session_id = ?`,
        sessionId,
      )
      .toArray();
    return rows[0];
  }

  /** 重复 join 是"已经在里面了"：主键冲突什么也不改（上游 `track` 的 alreadyTracked 早返回）。 */
  insert(row: MatchMemberRow): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO match_member (session_id, user_id, username, node, joined_at)
       VALUES (?, ?, ?, ?, ?)`,
      row.session_id,
      row.user_id,
      row.username,
      row.node,
      row.joined_at,
    );
  }

  delete(sessionId: string): MatchMemberRow | undefined {
    const row = this.find(sessionId);
    if (row === undefined) return undefined;
    this.sql.exec("DELETE FROM match_member WHERE session_id = ?", sessionId);
    return row;
  }

  count(): number {
    const rows = this.sql.exec<{ readonly n: number }>("SELECT COUNT(*) AS n FROM match_member").toArray();
    return rows[0]?.n ?? 0;
  }
}
