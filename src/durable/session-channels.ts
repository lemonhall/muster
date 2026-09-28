/**
 * 会话分片这一侧的频道状态：**这条会话加入了哪些频道**，以及 `ChannelService` 的实现。
 *
 * 为什么分片要知道自己加入了哪些频道：上游 `sessionWS.consume` 在连接结束时调用的是
 * `tracker.UntrackAll(sessionID, Update)`——它靠 tracker 里"按会话索引 presence"的那张表
 * 一次性摘掉这条会话在所有流里的 presence。本项目把每个频道的成员表放在了各自的
 * **频道 DO** 里，所以"按会话索引"的这一半只能留在分片上：分片记"我加入了谁"，
 * 断开时逐条通知。两张表各司其职，不是同一份状态的两份拷贝：
 * 分片这张只是**退订清单**，成员真相始终在频道 DO 那边（重复通知是幂等的）。
 *
 * 拿到 `joined` 就没有清理路径的分支：连接关闭是唯一出口，`leaveAll` 在 `#disconnect`
 * 里被调用（那条路同时覆盖客户端主动断开、平台报错、以及服务端主动关连接）。
 *
 * 契约源（机器可读）：
 * 契约源: server/session_ws.go::sessionWS.consume
 * 契约源: server/tracker.go::LocalTracker.UntrackAll
 *
 * REQ-0001-010
 */

import type { Bindings } from "../env";
import type {
  ChannelJoinInput,
  ChannelMessageEditInput,
  ChannelMemberInput,
  ChannelMessageInput,
  ChannelMessageRefInput,
  ChannelOpResult,
  ChannelService,
} from "../realtime/channel";
import { channelOp } from "./channel-call";

export class SessionChannels implements ChannelService {
  readonly #sql: SqlStorage;

  constructor(
    sql: SqlStorage,
    private readonly env: Bindings,
    private readonly tenantId: string,
  ) {
    this.#sql = sql;
  }

  /** 由分片在构造时通过 `blockConcurrencyWhile` 调用，保证第一个请求之前表已就绪。 */
  migrate(): void {
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS joined_channels (
         channel_id TEXT PRIMARY KEY
       );`,
    );
  }

  async join(input: ChannelJoinInput): Promise<ChannelOpResult> {
    const result = await channelOp(this.env, this.tenantId, input.channelId, "/join", input);
    // 只有真的进去了才记账：入参不合法时频道 DO 会拒绝，那时不该留下退订清单。
    if (result.ok) {
      this.#sql.exec("INSERT OR IGNORE INTO joined_channels (channel_id) VALUES (?)", input.channelId);
    }
    return result;
  }

  async leave(input: ChannelMemberInput): Promise<ChannelOpResult> {
    const result = await channelOp(this.env, this.tenantId, input.channelId, "/leave", input);
    if (result.ok) {
      this.#sql.exec("DELETE FROM joined_channels WHERE channel_id = ?", input.channelId);
    }
    return result;
  }

  async send(input: ChannelMessageInput): Promise<ChannelOpResult> {
    return await channelOp(this.env, this.tenantId, input.channelId, "/send", input);
  }

  async update(input: ChannelMessageEditInput): Promise<ChannelOpResult> {
    return await channelOp(this.env, this.tenantId, input.channelId, "/update", input);
  }

  async remove(input: ChannelMessageRefInput): Promise<ChannelOpResult> {
    return await channelOp(this.env, this.tenantId, input.channelId, "/remove", input);
  }

  /**
   * 连接结束：逐条通知本会话加入过的频道（上游 `UntrackAll`）。
   *
   * 先清清单再通知：即使某个频道 DO 调用失败，也不会因为"重试一遍 UnclearAll"而
   * 把清单留在原地（连接已经没了，这些条目没有意义）。失败只记日志——连接都没了，
   * 没有任何客户端可以被告知这次失败。
   */
  async leaveAll(sessionId: string): Promise<void> {
    const channels = this.#sql
      .exec<{ readonly channel_id: string; readonly [column: string]: SqlStorageValue }>(
        "SELECT channel_id FROM joined_channels ORDER BY channel_id",
      )
      .toArray()
      .map((row) => row.channel_id);
    this.#sql.exec("DELETE FROM joined_channels");
    if (channels.length === 0) return;
    await Promise.allSettled(
      channels.map((channelId) =>
        channelOp(this.env, this.tenantId, channelId, "/leaveAll", { sessionId }),
      ),
    );
  }
}
