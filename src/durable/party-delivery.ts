/**
 * 派对 DO 的收尾动作：同步目录、广播、撤票、销毁。
 *
 * 这三件事在所有"有人进出"的路径上都要做，而且顺序固定，所以单独一层：
 *
 * 1. `broadcastPresence` → 其他人先知道谁进来了 / 谁走了（上游由 tracker 的
 *    流事件发，接收者是**事件发生之后**还在流上的那些会话——加入者自己也在其中，
 *    离开者已经不在）；
 * 2. 队长继任（`afterDeparture`）→ 最老的那位接任并广播 `party_leader`；
 *    一个不剩 → 派对直接消失，**不发** `party_close`（上游 `stop()`）；
 * 3. `membershipChanged` → 成员变动一律撤掉这个派对的匹配票
 *    （上游 `RemovePartyAll`）。
 *
 * 投递失败只记日志：上游 `SendToStream` 找不到某个流时同样是跳过，一个成员的
 * 连接挂掉不该挡住（或拖垮）其他人的那一帧。
 *
 * 契约源（机器可读）：
 * 契约源: server/party_handler.go::PartyHandler.Leave
 * 契约源: server/tracker.go::LocalTracker.processEvent
 *
 * REQ-0001-019
 */

import type { Bindings } from "../env";
import { oldestOf, realMembers } from "../domain/party/members";
import { deletePartyRecord, upsertPartyRecord } from "../domain/party/store";
import type { PartyPresence } from "../domain/party/types";
import { LOCAL_NODE } from "../domain/party/ids";
import type { Envelope } from "../proto/realtime_pb";
import { partyLeaderEnvelope, partyPresenceEventEnvelope } from "../realtime/party";
import { matchmakerCall } from "./matchmaker-call";
import { partyDeliverTo, partyPresences } from "./party-roster";
import type { PartyMembers } from "./party-members";
import type { PartyRequests } from "./party-requests";

/** 一次"要补投给某个会话"的帧（踢人时给被踢者发的那条 `party_close`）。 */
export interface PartyExtraDelivery {
  readonly target: PartyPresence;
  readonly frame: Envelope;
}

export class PartyDelivery {
  constructor(
    private readonly env: Bindings,
    private readonly tenantId: string,
    private readonly partyId: string,
    private readonly members: PartyMembers,
    private readonly requests: PartyRequests,
  ) {}

  /** 真成员的 presence（预留位不算），顺序 = 进入顺序。 */
  presences(): readonly PartyPresence[] {
    return partyPresences(this.members.entries());
  }

  leader(): PartyPresence | null {
    return this.members.leader();
  }

  /** 发给全部真成员。 */
  async broadcastAll(frame: Envelope): Promise<void> {
    await partyDeliverTo(this.env, this.tenantId, this.presences(), frame);
  }

  /** 发给指定的收件人集合（空集合是空操作）。 */
  async broadcastTo(targets: readonly PartyPresence[], frame: Envelope): Promise<void> {
    await partyDeliverTo(this.env, this.tenantId, targets, frame);
  }

  /** 除某人之外的全部真成员。 */
  async broadcastExcept(exceptSessionId: string, frame: Envelope): Promise<void> {
    await this.broadcastTo(
      this.presences().filter((presence) => presence.sessionId !== exceptSessionId),
      frame,
    );
  }

  /**
   * 广播一条 `party_presence_event`。
   *
   * `exceptSessionId` 是"这一帧不发给他"的会话：上游靠 tracker 的流成员表决定
   * 接收者，而本项目在这一层显式给出排除项（加入时给新人的那一帧不是 presence
   * 事件，而是 `party` 帧——上游 `Join` 钩子对初始队长就是这么跳过的）。
   */
  async broadcastPresence(
    joins: readonly PartyPresence[],
    leaves: readonly PartyPresence[],
    exceptSessionId = "",
  ): Promise<void> {
    const targets = this.presences().filter((presence) => presence.sessionId !== exceptSessionId);
    await partyDeliverTo(
      this.env,
      this.tenantId,
      targets,
      partyPresenceEventEnvelope(this.partyId, joins, leaves),
    );
  }

  /**
   * 有人离开之后的共同收尾：presence 事件 → 队长继任或派对消失 → 撤票 → 补投递。
   *
   * 队长继任只处理"离开的人里包含当前队长"这一种情况，与上游一致（上游遍历
   * 被移除的人、命中队长就 `break`）。
   */
  async afterDeparture(
    removed: readonly PartyPresence[],
    extras: readonly PartyExtraDelivery[] = [],
  ): Promise<void> {
    await this.broadcastPresence([], removed);
    const leader = this.leader();
    if (leader !== null && removed.some((presence) => samePresence(presence, leader))) {
      const oldest = oldestOf(this.members.entries());
      if (oldest === undefined) {
        await this.destroy();
      } else {
        this.members.setLeader(oldest.presence);
        await this.broadcastAll(partyLeaderEnvelope(this.partyId, oldest.presence));
      }
    }
    await this.membershipChanged();
    for (const extra of extras) {
      await partyDeliverTo(this.env, this.tenantId, [extra.target], extra.frame);
    }
  }

  /** 成员变动 = 这个派对手上的匹配票全部作废（上游 `RemovePartyAll`）。 */
  async membershipChanged(): Promise<void> {
    try {
      await matchmakerCall(this.env, this.tenantId, "/removePartyAll", { partyId: this.partyId });
    } catch (error) {
      console.error("撤掉派对匹配票失败", error);
    }
  }

  /** 派对消失：清成员、清请求、清目录条目（上游 `stop()` + `Delete`）。 */
  async destroy(): Promise<void> {
    this.members.removeAll();
    this.members.clearLeader();
    // 元数据也要一起清：`meta() === null` 是"派对不存在"的判据（见 `clearMeta` 的注释）。
    this.members.clearMeta();
    this.requests.removeAll();
    try {
      await deletePartyRecord(this.env.DB, this.tenantId, this.partyId);
    } catch (error) {
      console.error("派对目录清理失败", error);
    }
  }

  /**
   * 把这一行同步到 `party_record`（列表端点的数据源）。
   *
   * 失败只记日志：D1 抖一下不该让"我已经建好派对了"这件事失败——派对 DO 里的状态
   * 才是权威，目录少一条是可见的小偏差，而把一次成功的创建变成 500 不可接受。
   */
  async syncRecord(uuid: string): Promise<void> {
    const meta = this.members.meta();
    if (meta === null) return;
    try {
      await upsertPartyRecord(this.env.DB, this.tenantId, {
        partyId: this.partyId,
        uuid,
        node: LOCAL_NODE,
        open: meta.open,
        hidden: meta.hidden,
        maxSize: meta.maxSize,
        label: meta.label,
        createTime: meta.createTime,
      });
    } catch (error) {
      console.error("派对目录同步失败", error);
    }
  }

  /** 真成员（预留位不算）。 */
  realMembers() {
    return realMembers(this.members.entries());
  }
}

/** 上游比较 presence 用的是三件套（会话 / 用户 / 用户名），派对内不看节点。 */
export function samePresence(left: PartyPresence, right: PartyPresence): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.userId === right.userId &&
    left.username === right.username
  );
}
