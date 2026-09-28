/**
 * 频道语义：成员、presence、消息与历史。**与 DO 外壳分开的那一半。**
 *
 * 为什么要分出来："谁是成员"（SQL）、"一个频道长什么样"（wire）、"这一帧该不该发"
 * （语义）是三件事。`channel.ts` 只做路由与闹钟，`channel-members.ts` /
 * `channel-messages.ts` 只管 SQL，语义全在这里，于是它可以被逐条断言而不必开 socket。
 *
 * 一条关键设计（与上游的实现**形状**不同，但可观测行为一致）：广播由本类发起，
 * 但**不发给发起这次操作的会话**——那条会话自己的那一份，作为回帧返回给分片，
 * 由分片自己按顺序发出。两个原因：
 *
 * 1. **不能造成 DO 自己调自己**：发起操作的是会话分片，"频道 DO → 会话分片"如果打回
 *    正在等这次调用的那个分片，就形成一条自己等自己的链；
 * 2. **顺序可控**：上游的顺序是"先广播、后回执"，而分片把"广播帧 + 回执帧"一起拿到，
 *    按数组顺序发出即可，不依赖两次异步投递谁先落地。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_channel.go::Pipeline.channelJoin
 * 契约源: server/pipeline_channel.go::Pipeline.channelLeave
 * 契约源: server/pipeline_channel.go::Pipeline.channelMessageSend
 * 契约源: server/tracker.go::LocalTracker.UntrackAll
 *
 * REQ-0001-010
 */

import type { Bindings } from "../env";
import type { Envelope } from "../proto/realtime_pb";
import {
  CHANNEL_MESSAGE_TYPE,
  channelEnvelope,
  channelMessageAckOf,
  channelMessageEnvelope,
  channelPresenceEventEnvelope,
  channelTemplate,
  type ChannelHistoryInput,
  type ChannelJoinInput,
  type ChannelMessageEditInput,
  type ChannelMessageWire,
  type ChannelMessageInput,
  type ChannelMessageRefInput,
  type ChannelMemberInput,
  type ChannelOpResult,
  type ChannelPresence,
  type ChannelTemplate,
} from "../realtime/channel";
import type { ChannelStream } from "../realtime/channel-ids";
import { ackEnvelope } from "../realtime/errors";
import { ChannelFanout } from "./channel-fanout";
import type { ChannelEditContext } from "./channel-message-edit";
import { removeChannelMessage, updateChannelMessage } from "./channel-message-edit";
import type { ChannelMembers, MemberRow } from "./channel-members";
import type { ChannelMessages, MessageRow } from "./channel-messages";
import { readChannelHistory, type ChannelHistoryPage } from "./channel-history";
import { registryCall } from "./registry-call";

function presenceOfRow(row: MemberRow): ChannelPresence {
  return {
    userId: row.user_id,
    sessionId: row.session_id,
    username: row.username,
    persistence: row.persistence === 1,
  };
}

function failure(code: "BAD_INPUT" | "RUNTIME_EXCEPTION", message: string): ChannelOpResult {
  return { ok: false, code, message };
}

function messageRowOf(message: ChannelMessageWire): MessageRow {
  return {
    id: message.messageId,
    code: message.code,
    sender_id: message.senderId,
    username: message.username,
    content: message.content,
    create_time_ms: message.createTimeMs,
    update_time_ms: message.updateTimeMs,
  };
}

export class ChannelCore {
  readonly #template: ChannelTemplate;
  readonly #fanout: ChannelFanout;

  constructor(
    private readonly env: Bindings,
    private readonly tenantId: string,
    private readonly channelId: string,
    private readonly stream: ChannelStream,
    private readonly members: ChannelMembers,
    private readonly messages: ChannelMessages,
  ) {
    this.#template = channelTemplate(stream);
    this.#fanout = new ChannelFanout(env, tenantId, members);
  }

  memberCount(): number {
    return this.members.count();
  }

  async join(input: ChannelJoinInput): Promise<ChannelOpResult> {
    // 重复 join 是"什么也不改"（上游 Track 的 alreadyTracked 早返回）：meta 不更新、
    // 不发事件，而 presences 里连自己都会在（因为已经不是"新加入"）。
    const { isNew } = this.members.track(
      {
        sessionId: input.sessionId,
        userId: input.userId,
        username: input.username,
        persistence: input.persistence,
        hidden: input.hidden,
      },
      Date.now(),
    );
    const self = this.members.find(input.sessionId, input.userId);
    if (self === undefined) return failure("RUNTIME_EXCEPTION", "Error joining channel");

    const presences = this.members
      .visible()
      .filter(
        (row) => !(isNew && row.session_id === input.sessionId && row.user_id === input.userId),
      )
      .map(presenceOfRow);

    const replies: Envelope[] = [
      channelEnvelope(input.cid, this.channelId, this.#template, presenceOfRow(self), presences),
    ];
    if (isNew && !input.hidden) {
      // 上游：新加入且不隐藏 → 广播 joins，接收者包含自己（先回 channel 帧、后到事件）。
      // 私聊请求通知（NotificationCodeDmRequest）属于通知域，M5 落地（见 ECN-0007）。
      const event = channelPresenceEventEnvelope(
        this.channelId,
        this.#template,
        [presenceOfRow(self)],
        [],
      );
      await this.#fanout.send(input.sessionId, event);
      replies.push(event);
    }
    return { ok: true, replies };
  }

  async leave(input: ChannelMemberInput): Promise<ChannelOpResult> {
    const removed = this.members.untrack(input.sessionId, input.userId);
    // 没加入过 = 上游 Untrack 的早返回；hidden 成员离开**不产生**事件。
    if (removed !== undefined && removed.hidden === 0) {
      await this.#fanout.send(
        "",
        channelPresenceEventEnvelope(this.channelId, this.#template, [], [presenceOfRow(removed)]),
      );
    }
    return { ok: true, replies: [ackEnvelope(input.cid)] };
  }

  /** 连接关闭：一条会话在这个频道里的全部 presence 一起摘掉（上游 `UntrackAll`）。 */
  async leaveAll(sessionId: string): Promise<void> {
    const leaves = this.members
      .untrackSession(sessionId)
      .filter((row) => row.hidden === 0)
      .map(presenceOfRow);
    if (leaves.length > 0) {
      await this.#fanout.send(
        "",
        channelPresenceEventEnvelope(this.channelId, this.#template, [], leaves),
      );
    }
  }

  async send(input: ChannelMessageInput): Promise<ChannelOpResult> {
    const sender = this.members.find(input.sessionId, input.userId);
    if (sender === undefined) {
      return failure("BAD_INPUT", "Must join channel before sending messages");
    }
    const at = this.messages.nextTimestampMs(Date.now());
    const message: ChannelMessageWire = {
      messageId: crypto.randomUUID(),
      code: CHANNEL_MESSAGE_TYPE.chat,
      senderId: input.userId,
      username: input.username,
      content: input.content,
      createTimeMs: at,
      updateTimeMs: at,
      persistent: sender.persistence === 1,
    };
    if (message.persistent) this.messages.insert(messageRowOf(message));
    const broadcast = channelMessageEnvelope(this.channelId, this.#template, message);
    await this.#fanout.send(input.sessionId, broadcast);
    return {
      ok: true,
      replies: [broadcast, channelMessageAckOf(input.cid, this.channelId, this.#template, message)],
    };
  }

  /** 修改/删除的语义在 `channel-message-edit.ts`（那条"只有发送者能改"的规则只有一处）。 */
  async update(input: ChannelMessageEditInput): Promise<ChannelOpResult> {
    return updateChannelMessage(this.#editContext(), input);
  }

  async remove(input: ChannelMessageRefInput): Promise<ChannelOpResult> {
    return removeChannelMessage(this.#editContext(), input);
  }

  list(input: ChannelHistoryInput): ChannelHistoryPage {
    return readChannelHistory(this.messages, this.stream, {
      limit: input.limit,
      forward: input.forward,
      cursor: input.cursor,
    });
  }

  /**
   * 兜底巡检：对注册表问"这些会话还有活着的吗"，把没活的成员摘掉并补 leave。
   *
   * 正常路径上不需要它（连接关闭会主动上报，见 `leaveAll`）。它兜的是"分片被平台
   * 硬杀、没来得及上报"这种情形——注册表是**唯一**的活性判据，所以这里问它，
   * 而不是自己再养一套心跳。
   */
  async sweep(): Promise<void> {
    const sessions = this.members.sessions();
    if (sessions.length === 0) return;
    let alive: readonly string[];
    try {
      const result = await registryCall<{ alive: string[] }>(
        this.env,
        this.tenantId,
        "/alive",
        { sessionIds: sessions },
      );
      alive = result.alive;
    } catch (error) {
      // 问不到就**什么都不做**：宁可留一个幽灵成员，也不要把在线的人误踢出去。
      console.error("频道成员巡检失败，本次保留全部成员", error);
      return;
    }
    const aliveSet = new Set(alive);
    const dead = sessions.filter((sessionId) => !aliveSet.has(sessionId));
    const dropped = this.members
      .dropSessions(dead)
      .filter((row) => row.hidden === 0)
      .map(presenceOfRow);
    if (dropped.length > 0) {
      await this.#fanout.send(
        "",
        channelPresenceEventEnvelope(this.channelId, this.#template, [], dropped),
      );
    }
  }

  /** 交给 `channel-message-edit.ts` 的那一小撮依赖；它只碰这几个，碰不到路由与闹钟。 */
  #editContext(): ChannelEditContext {
    return {
      channelId: this.channelId,
      template: this.#template,
      members: this.members,
      messages: this.messages,
      fanout: this.#fanout,
    };
  }
}
