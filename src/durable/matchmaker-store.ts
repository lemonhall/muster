/**
 * 匹配池的持久层（DO 的 SQLite）。
 *
 * 上游的池子是**纯进程内内存**：进程重启，所有等票消失（`LocalMatchmaker` 里那三张
 * map 没有落盘路径，只有运维用的 `Insert` 恢复入口）。本项目把票落盘，于是
 * "DO 被平台换掉一个实例"不会让等票的人凭空消失——这是刻意的偏差，登记在
 * ECN-0011 偏差 1。
 *
 * 存的是 `MatchmakerExtract`（上一里程碑定的"可搬运形状"）的 JSON 文本，
 * 而不是把 `MatchmakerIndex` 整个序列化：`parsed` 里是 RegExp 与函数，不该进存储。
 * 恢复时重新解析一次查询串，与"这张票刚被 `Add` 进来"走的是同一条路。
 *
 * 契约源（机器可读）：
 * 契约源: server/matchmaker.go::LocalMatchmaker.Insert
 * 契约源: server/matchmaker.go::LocalMatchmaker.Extract
 *
 * REQ-0001-017
 */

import type { MatchmakerExtract } from "../domain/matchmaker/types";
import type { MatchedHook } from "./matchmaker-hook";

/** 可持久化的池子配置。缺省值由 DO 决定（与上游 `config.Matchmaker` 的默认值一致）。 */
export interface StoredMatchmakerConfig {
  readonly maxTickets?: number;
  readonly maxIntervals?: number;
  readonly revPrecision?: boolean;
  readonly revThreshold?: number;
  /** 成局轮询间隔（毫秒）。上游是 `IntervalSec`（秒），这里换成毫秒便于测试注入。 */
  readonly intervalMs?: number;
}

export class MatchmakerStore {
  constructor(private readonly sql: SqlStorage) {}

  migrate(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS matchmaker_ticket (
         ticket     TEXT PRIMARY KEY,
         payload    TEXT NOT NULL,
         created_at INTEGER NOT NULL
       );`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS matchmaker_setting (
         key   TEXT PRIMARY KEY,
         value TEXT NOT NULL
       );`,
    );
  }

  /** 池子里的全部票（按创建时间升序，恢复顺序稳定）。坏了的一行直接跳过。 */
  tickets(): readonly MatchmakerExtract[] {
    const rows = this.sql
      .exec<{ readonly payload: string }>(
        "SELECT payload FROM matchmaker_ticket ORDER BY created_at, ticket",
      )
      .toArray();
    const extracts: MatchmakerExtract[] = [];
    for (const row of rows) {
      try {
        extracts.push(JSON.parse(row.payload) as MatchmakerExtract);
      } catch {
        // 坏行不该拦住整池恢复：跳过它，其余票照常可配对。
      }
    }
    return extracts;
  }

  insert(extract: MatchmakerExtract, createdAt: number): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO matchmaker_ticket (ticket, payload, created_at) VALUES (?, ?, ?)",
      extract.ticket,
      JSON.stringify(extract),
      createdAt,
    );
  }

  delete(tickets: readonly string[]): void {
    for (const ticket of tickets) {
      this.sql.exec("DELETE FROM matchmaker_ticket WHERE ticket = ?", ticket);
    }
  }

  clear(): void {
    this.sql.exec("DELETE FROM matchmaker_ticket");
  }

  hook(): MatchedHook | null {
    const raw = this.#setting("matched_hook");
    if (raw === undefined) return null;
    try {
      return JSON.parse(raw) as MatchedHook;
    } catch {
      return null;
    }
  }

  setHook(hook: MatchedHook | null): void {
    if (hook === null) {
      this.sql.exec("DELETE FROM matchmaker_setting WHERE key = 'matched_hook'");
      return;
    }
    this.#setSetting("matched_hook", JSON.stringify(hook));
  }

  config(): StoredMatchmakerConfig {
    const raw = this.#setting("config");
    if (raw === undefined) return {};
    try {
      return JSON.parse(raw) as StoredMatchmakerConfig;
    } catch {
      return {};
    }
  }

  setConfig(config: StoredMatchmakerConfig): void {
    this.#setSetting("config", JSON.stringify(config));
  }

  #setting(key: string): string | undefined {
    const rows = this.sql
      .exec<{ readonly value: string }>("SELECT value FROM matchmaker_setting WHERE key = ?", key)
      .toArray();
    return rows[0]?.value;
  }

  #setSetting(key: string, value: string): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO matchmaker_setting (key, value) VALUES (?, ?)",
      key,
      value,
    );
  }
}
