/**
 * 派对的加入请求表（派对 DO 的 SQLite）。
 *
 * 上游把待批的请求放在 `PartyHandler.joinRequests` 这个切片里，队长批一个就从前到后
 * 找到它、按 `copy(...)` 从切片里挖掉（保持剩下几位的相对顺序）。本项目用一张表 +
 * 自增 `request_seq`，`ORDER BY request_seq` 就是那个切片。
 *
 * 上限也照抄：`len(joinRequests) >= MaxSize` 时不再收新请求（`party join requests full`）。
 * 注意这个上限用的是 `max_size` 而不是"请求数上限"——上游就是这么写的。
 *
 * 契约源（机器可读）：
 * 契约源: server/party_handler.go::PartyHandler.JoinRequest
 * 契约源: server/party_handler.go::PartyHandler.Remove
 *
 * REQ-0001-019
 */

import type { PartyPresence, PartyRequestEntry } from "../domain/party/types";

interface RequestRow {
  readonly session_id: string;
  readonly user_id: string;
  readonly username: string;
  readonly node: string;
  readonly request_seq: number;
  readonly [column: string]: SqlStorageValue;
}

export class PartyRequests {
  constructor(private readonly sql: SqlStorage) {}

  migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS party_request (
        session_id  TEXT    PRIMARY KEY,
        user_id     TEXT    NOT NULL,
        username    TEXT    NOT NULL,
        node        TEXT    NOT NULL,
        request_seq INTEGER NOT NULL
      );
    `);
  }

  entries(): readonly PartyRequestEntry[] {
    return this.sql
      .exec<RequestRow>(
        "SELECT session_id, user_id, username, node, request_seq FROM party_request ORDER BY request_seq ASC, session_id ASC",
      )
      .toArray()
      .map((row) => ({
        presence: {
          userId: row.user_id,
          sessionId: row.session_id,
          username: row.username,
          node: row.node,
        },
        seq: row.request_seq,
      }));
  }

  /** 同一个会话重复请求时覆盖那一行（上游靠"重复请求"校验先把它挡掉，这里是兜底）。 */
  add(presence: PartyPresence, node: string): void {
    this.sql.exec(
      "INSERT INTO party_request (session_id, user_id, username, node, request_seq) " +
        "VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(request_seq), 0) + 1 FROM party_request)) " +
        "ON CONFLICT (session_id) DO UPDATE SET user_id = excluded.user_id, username = excluded.username",
      presence.sessionId,
      presence.userId,
      presence.username,
      node,
    );
  }

  remove(sessionId: string): boolean {
    const before = this.count();
    this.sql.exec("DELETE FROM party_request WHERE session_id = ?", sessionId);
    return this.count() < before;
  }

  removeAll(): void {
    this.sql.exec("DELETE FROM party_request");
  }

  count(): number {
    const rows = this.sql.exec<{ readonly n: number }>("SELECT COUNT(*) AS n FROM party_request").toArray();
    return rows[0]?.n ?? 0;
  }
}
