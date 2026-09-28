/**
 * 频道广播：把一帧投递给频道里**除某条会话之外**的所有成员。
 *
 * 为什么单独一层：`ChannelCore` 的五条语义分支都要广播，但它们关心的只是"发什么"，
 * 不关心"怎么送到别人手上"（那是会话分片的活儿）。抽出来之后，"排除谁"这条规则
 * 只有一处实现，也就不会在这里漏掉一个 `except`。
 *
 * 投递**不区分可见性**：hidden 成员在快照与事件里看不见，但广播照收——上游
 * `LocalTracker` 的 queueEvent 只跳过 hidden 的 **presence 事件**，不跳过消息。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_channel.go::Pipeline.channelMessageSend
 *
 * REQ-0001-010
 */

import type { Bindings } from "../env";
import type { Envelope } from "../proto/realtime_pb";
import type { ChannelMembers } from "./channel-members";
import { deliverToSession } from "./delivery";

export class ChannelFanout {
  constructor(
    private readonly env: Bindings,
    private readonly tenantId: string,
    private readonly members: ChannelMembers,
  ) {}

  /** 发给除 `exceptSessionId` 之外的全部成员；`""` 表示不排除任何人。 */
  async send(exceptSessionId: string, envelope: Envelope): Promise<void> {
    const targets = this.members
      .sessions()
      .filter((sessionId) => sessionId !== exceptSessionId);
    if (targets.length === 0) return;
    // 一条会话的投递失败不能拖垮其余成员：`allSettled` + 不抛，失败留给 sweeper 清理。
    await Promise.allSettled(
      targets.map((sessionId) => deliverToSession(this.env, this.tenantId, sessionId, envelope)),
    );
  }
}
