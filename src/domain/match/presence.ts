/**
 * 对局成员表。
 *
 * 上游 `MatchPresenceList`（`server/match_presence.go`）是一张"会话 → 成员"的
 * 哈希表，`Join` 覆盖、`Leave` 删除、`ListPresences` 按插入序返回一份快照。
 * 三个动作都可观测：`match_join` 回执里的 `size` 是 `Size()`、
 * `presences` 是 `ListPresences()`、离开之后 `size` 必须跟着掉。
 *
 * 与上游唯一的差别是**存储**：上游是进程内 map，这里既可以放进 DO 的 SQLite
 * （权威对局实例），也可以在测试里当成纯内存对象用。两类调用方共用同一份语义
 * （ECN-0011 偏差 7）。
 *
 * 契约源（机器可读）：
 * 契约源: server/match_presence.go::MatchPresenceList
 * 契约源: server/match_presence.go::MatchPresenceList.Join
 * 契约源: server/match_presence.go::MatchPresenceList.Leave
 *
 * REQ-0001-018
 */

export interface MatchPresence {
  readonly node: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly username: string;
}

/**
 * 有序成员表。
 *
 * 为什么用 `Map`（而不是普通对象）：`ListPresences` 的顺序要稳定——上游是
 * Go map（随机序），但客户端只看集合语义；本项目选**插入序**，于是"同一批操作
 * 得到同一份快照"总是成立（ECN-0011 偏差 5）。
 */
export class MatchPresenceList {
  readonly #members = new Map<string, MatchPresence>();

  /** 会话 id 是主键：同一会话重复加入时覆盖（上游 `tracker.Track` 是 upsert）。 */
  join(presences: readonly MatchPresence[]): void {
    for (const presence of presences) this.#members.set(presence.sessionId, presence);
  }

  leave(presences: readonly MatchPresence[]): void {
    for (const presence of presences) this.#members.delete(presence.sessionId);
  }

  leaveSession(sessionId: string): void {
    this.#members.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.#members.has(sessionId);
  }

  size(): number {
    return this.#members.size;
  }

  list(): readonly MatchPresence[] {
    return [...this.#members.values()];
  }

  /**
   * 上游 `JoinAttempt` 回给调用方的成员快照：**不含**刚加入的这个人。
   * （`pipeline_match.go` 里那段 `if isNew && p.UserID == session.UserID() ... continue`）
   */
  listForJoiner(sessionId: string): readonly MatchPresence[] {
    return this.list().filter((presence) => presence.sessionId !== sessionId);
  }

  /** 广播用：除了某条会话之外的所有人。 */
  listExcept(sessionId: string): readonly MatchPresence[] {
    return this.list().filter((presence) => presence.sessionId !== sessionId);
  }
}
