/**
 * 派对成员表与元数据表（派对 DO 的 SQLite）。
 *
 * 上游把派对状态全放在进程内存里：`PartyHandler` 持有 `Open` / `MaxSize` /
 * `CreateTime` / leader，成员在 `PartyPresenceList`，目录条目在 bluge 索引。
 * 本项目把它收进**一个派对一个 DO**的 SQLite（ECN-0013 偏差 1），于是
 * "重启后派对还在"是我们的行为、不是上游的；这条差异记在 ECN 里，测试不依赖它。
 *
 * 这一层只做存储：**规则在 `src/domain/party/members.ts`**（纯函数，可逐条断言），
 * 决定"谁能进、谁是队长、该给谁发帧"的是那一份实现。
 *
 * `label` 恒为字符串（上游在创建时把空串规整成 `{}`），不像对局标签那样允许 NULL：
 * 派对一定带标签字段，`party` 帧里它总是出现。
 *
 * 契约源（机器可读）：
 * 契约源: server/party_presence.go::PartyPresenceList.Join
 * 契约源: server/party_presence.go::PartyPresenceList.Leave
 * 契约源: server/party_presence.go::PartyPresenceList.Oldest
 *
 * REQ-0001-019
 */

import type { PartyMemberEntry, PartyPresence } from "../domain/party/types";
import { realMembers } from "../domain/party/members";

interface MemberRow {
  readonly session_id: string;
  readonly user_id: string;
  readonly username: string;
  readonly node: string;
  readonly reserved: number;
  readonly join_seq: number;
  readonly [column: string]: SqlStorageValue;
}

interface MetaRow {
  readonly open: number;
  readonly hidden: number;
  readonly max_size: number;
  readonly label: string;
  readonly create_time: number;
  readonly [column: string]: SqlStorageValue;
}

interface LeaderRow {
  readonly user_id: string;
  readonly session_id: string;
  readonly username: string;
  readonly node: string;
  readonly [column: string]: SqlStorageValue;
}

/** 派对元数据（一个派对一行）。 */
export interface PartyMeta {
  readonly open: boolean;
  readonly hidden: boolean;
  readonly maxSize: number;
  readonly label: string;
  /** 创建时间，Unix 秒。 */
  readonly createTime: number;
}

export class PartyMembers {
  constructor(private readonly sql: SqlStorage) {}

  migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS party_meta (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        open        INTEGER NOT NULL,
        hidden      INTEGER NOT NULL,
        max_size    INTEGER NOT NULL,
        label       TEXT    NOT NULL DEFAULT '{}',
        create_time INTEGER NOT NULL
      );
    `);
    // 队长在内存里是 `PartyHandler.leader`；落盘之后"队长是谁"必须能被重启后读回来，
    // 否则私有派对的 `party leader only` 校验会在 DO 被唤醒后失效。
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS party_leader (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        user_id    TEXT NOT NULL,
        session_id TEXT NOT NULL,
        username   TEXT NOT NULL,
        node       TEXT NOT NULL
      );
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS party_member (
        session_id TEXT    PRIMARY KEY,
        user_id    TEXT    NOT NULL,
        username   TEXT    NOT NULL,
        node       TEXT    NOT NULL,
        reserved   INTEGER NOT NULL DEFAULT 0,
        join_seq   INTEGER NOT NULL
      );
    `);
  }

  meta(): PartyMeta | null {
    const rows = this.sql
      .exec<MetaRow>("SELECT open, hidden, max_size, label, create_time FROM party_meta WHERE id = 1")
      .toArray();
    const row = rows[0];
    if (row === undefined) return null;
    return {
      open: row.open === 1,
      hidden: row.hidden === 1,
      maxSize: row.max_size,
      label: row.label,
      createTime: row.create_time,
    };
  }

  setMeta(meta: PartyMeta): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO party_meta (id, open, hidden, max_size, label, create_time) VALUES (1, ?, ?, ?, ?, ?)",
      meta.open ? 1 : 0,
      meta.hidden ? 1 : 0,
      meta.maxSize,
      meta.label,
      meta.createTime,
    );
  }

  /**
   * 派对消失：元数据那一行也要删掉。
   *
   * 这一条是**必须**的：`meta() === null` 就是"这个派对不存在"的判据，
   * 留着它会让关闭之后的 `party_join` 又把人加进一个"已经不存在"的派对
   * （上游此时已经从注册表里删掉了那个 handler，回的是 `party not found`）。
   */
  clearMeta(): void {
    this.sql.exec("DELETE FROM party_meta");
  }

  /** 标签更新只动这三列（上游 `LabelUpdate` 不动创建时间）。 */
  setListing(open: boolean, hidden: boolean, label: string): void {
    this.sql.exec(
      "UPDATE party_meta SET open = ?, hidden = ?, label = ? WHERE id = 1",
      open ? 1 : 0,
      hidden ? 1 : 0,
      label,
    );
  }

  leader(): PartyPresence | null {
    const rows = this.sql
      .exec<LeaderRow>("SELECT user_id, session_id, username, node FROM party_leader WHERE id = 1")
      .toArray();
    const row = rows[0];
    if (row === undefined) return null;
    return {
      userId: row.user_id,
      sessionId: row.session_id,
      username: row.username,
      node: row.node,
    };
  }

  setLeader(presence: PartyPresence): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO party_leader (id, user_id, session_id, username, node) VALUES (1, ?, ?, ?, ?)",
      presence.userId,
      presence.sessionId,
      presence.username,
      presence.node,
    );
  }

  clearLeader(): void {
    this.sql.exec("DELETE FROM party_leader");
  }

  /** 成员 + 预留位，按进入顺序。`size` / `oldest` 都由这份快照算出来。 */
  entries(): readonly PartyMemberEntry[] {
    return this.sql
      .exec<MemberRow>(
        "SELECT session_id, user_id, username, node, reserved, join_seq FROM party_member ORDER BY join_seq ASC, session_id ASC",
      )
      .toArray()
      .map((row) => ({
        presence: {
          userId: row.user_id,
          sessionId: row.session_id,
          username: row.username,
          node: row.node,
        },
        reserved: row.reserved !== 0,
        seq: row.join_seq,
      }));
  }

  real(entries: readonly PartyMemberEntry[]): readonly PartyMemberEntry[] {
    return realMembers(entries);
  }

  /**
   * 插入或更新一行成员。重复插入是**幂等**的（会话已经在里面 → 只刷新预留位与
   * 用户名），因为上游 `Join` 对已在表里的人也是"静默跳过"。
   */
  upsert(presence: PartyPresence, node: string, reserved: boolean): void {
    this.sql.exec(
      "INSERT INTO party_member (session_id, user_id, username, node, reserved, join_seq) " +
        "VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(join_seq), 0) + 1 FROM party_member)) " +
        "ON CONFLICT (session_id) DO UPDATE SET reserved = excluded.reserved",
      presence.sessionId,
      presence.userId,
      presence.username,
      node,
      reserved ? 1 : 0,
    );
  }

  /** 删一行，返回是否真的删掉了（上游 `Leave` 返回"真的被移除的人"）。 */
  remove(sessionId: string): boolean {
    const before = this.count();
    this.sql.exec("DELETE FROM party_member WHERE session_id = ?", sessionId);
    return this.count() < before;
  }

  removeAll(): void {
    this.sql.exec("DELETE FROM party_member");
  }

  count(): number {
    const rows = this.sql.exec<{ readonly n: number }>("SELECT COUNT(*) AS n FROM party_member").toArray();
    return rows[0]?.n ?? 0;
  }
}
