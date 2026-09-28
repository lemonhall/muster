/**
 * 频道 DO 的消息表：**只存持久化过的**消息。
 *
 * 与上游的 `message` 表对齐（`server/core_channel.go`）：
 * - 只有 `persist=true` 的发送才 INSERT；非持久化消息是"广播完就没了"；
 * - 编辑只更新 `username`/`content`/`update_time`，`create_time` 不动；
 * - **只有发送者本人**能改删（`WHERE id = ? AND sender_id = ?`），改不动就返回空 ——
 *   上层据此回上游那句 `Could not find message to update in channel history`；
 * - 删除是物理删除（上游就是 `DELETE`），所以"删除"之后历史里真的没有这条了。
 *
 * 与上游的差异：
 * 1. 上游一个 `message` 表装**所有**频道的消息，靠 `stream_mode/subject/descriptor/label`
 *    四列区分；本项目每个频道一个 DO，表就在这个 DO 里，那四列被"哪个 DO"取代
 *    （见 ECN-0007）。键索引因此只按 `(create_time_ms, id)`。
 * 2. 时间戳精度从纳秒降到毫秒（SQLite 存整数，JS 也只有 ms）。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_channel.go::ChannelMessageSend
 * 契约源: server/core_channel.go::ChannelMessageUpdate
 * 契约源: server/core_channel.go::ChannelMessageRemove
 *
 * REQ-0001-010
 */

export interface MessageRow {
  readonly id: string;
  readonly code: number;
  readonly sender_id: string;
  readonly username: string;
  readonly content: string;
  readonly create_time_ms: number;
  readonly update_time_ms: number;
  readonly [column: string]: SqlStorageValue;
}

export interface ScanAnchor {
  readonly createTimeMs: number;
  readonly id: string;
}

export interface StoredTimes {
  readonly create_time_ms: number;
  readonly update_time_ms: number;
}

export class ChannelMessages {
  constructor(private readonly sql: SqlStorage) {}

  migrate(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS messages (
         id TEXT PRIMARY KEY,
         code INTEGER NOT NULL,
         sender_id TEXT NOT NULL,
         username TEXT NOT NULL,
         content TEXT NOT NULL,
         create_time_ms INTEGER NOT NULL,
         update_time_ms INTEGER NOT NULL
       );
       CREATE INDEX IF NOT EXISTS messages_by_time ON messages(create_time_ms, id);
       CREATE INDEX IF NOT EXISTS messages_by_sender ON messages(sender_id);`,
    );
  }

  insert(row: MessageRow): void {
    this.sql.exec(
      `INSERT INTO messages (id, code, sender_id, username, content, create_time_ms, update_time_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.code,
      row.sender_id,
      row.username,
      row.content,
      row.create_time_ms,
      row.update_time_ms,
    );
  }

  /**
   * 新消息的 `create_time`：`now`，但保证**严格大于**库里已有的最大值。
   *
   * 为什么要这层夹紧：上游的时间戳是 `time.Now()`（纳秒），同一毫秒里连发两条在本项目
   * 是**很可能**发生的，而排序键是 `(create_time, id)`——时间戳打平之后顺序就由 uuid
   * 决定，"我按顺序发的三条消息历史里乱序"就成了随机失败。夹紧之后，频道内的时间戳
   * 单调递增，历史顺序恒等于发送顺序（毫秒精度本身是 ECN-0007 登记的偏差）。
   */
  nextTimestampMs(now: number): number {
    const row = this.sql
      .exec<{ readonly max_ms: number | null; readonly [column: string]: SqlStorageValue }>(
        "SELECT MAX(create_time_ms) AS max_ms FROM messages",
      )
      .toArray()[0];
    const max = row?.max_ms ?? null;
    return max === null || now > max ? now : max + 1;
  }

  /**
   * 改一条消息的内容。`sender_id` 是**写进 WHERE 的权限判据**：不是发送者就一行都改不到。
   * 返回真值里的 `create_time_ms` 用来把回执的 `create_time` 换成库里的真值（上游 `RETURNING`）。
   */
  update(
    messageId: string,
    senderId: string,
    username: string,
    content: string,
    updateTimeMs: number,
  ): { readonly create_time_ms: number } | undefined {
    return this.sql
      .exec<{ readonly create_time_ms: number; readonly [column: string]: SqlStorageValue }>(
        `UPDATE messages SET username = ?, content = ?, update_time_ms = ?
         WHERE id = ? AND sender_id = ?
         RETURNING create_time_ms`,
        username,
        content,
        updateTimeMs,
        messageId,
        senderId,
      )
      .toArray()[0];
  }

  /** 删一条消息，同样只能删自己的。返回库里的两个时间戳，供回执回填。 */
  remove(messageId: string, senderId: string): StoredTimes | undefined {
    return this.sql
      .exec<StoredTimes & { readonly [column: string]: SqlStorageValue }>(
        "DELETE FROM messages WHERE id = ? AND sender_id = ? RETURNING create_time_ms, update_time_ms",
        messageId,
        senderId,
      )
      .toArray()[0];
  }

  /**
   * 按方向扫 `limit + 1` 行。
   *
   * 为什么多扫一行：上游靠"第 limit+1 行"判断还有没有下一页，并把**那一行**当成下一页
   * 的游标（不是最后返回的那一行）。所以"有没有下一页"与"下一页从哪开始"是同一个判断，
   * 多扫一行是最省事的等价实现。
   */
  scan(ascending: boolean, limitPlusOne: number, anchor: ScanAnchor | undefined): MessageRow[] {
    const order = ascending ? "ASC" : "DESC";
    const compare = ascending ? ">" : "<";
    if (anchor === undefined) {
      return this.sql
        .exec<MessageRow>(
          `SELECT * FROM messages ORDER BY create_time_ms ${order}, id ${order} LIMIT ?`,
          limitPlusOne,
        )
        .toArray();
    }
    return this.sql
      .exec<MessageRow>(
        `SELECT * FROM messages
         WHERE create_time_ms ${compare} ?1
            OR (create_time_ms = ?1 AND id ${compare} ?2)
         ORDER BY create_time_ms ${order}, id ${order} LIMIT ?3`,
        anchor.createTimeMs,
        anchor.id,
        limitPlusOne,
      )
      .toArray();
  }
}
