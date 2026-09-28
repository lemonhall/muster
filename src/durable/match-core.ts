/**
 * 一个对局实例的语义：创建、加入、离开、数据路由。
 *
 * 与 `channel-core.ts` 同一个套路：DO 外壳只解析路由与编解码，语义在这里，
 * 于是"谁是成员、这一帧该发给谁"可以在不连网络的情况下被断言。
 *
 * 三条对齐上游的规则：
 * 1. **中继对局的 join 必须已经存在**（除非它来自 token：token 就是"新建一场中继对局"
 *    的指令），否则是 `Match not found`；权威对局同理，只是多一层"节点必须是我"；
 * 2. **权威对局的数据广播会回显给发送者**（上游 `BroadcastMessage` 在 `presences == nil`
 *    时取 `ListPresenceIDs()`，发送者也在里面）；中继对局**不回显**，除非发送者把自己
 *    写进 `presences` 过滤器；
 * 3. 成员变动会**广播 `match_presence_event`**（joins / leaves），这条对两种对局都成立。
 *
 * 一处刻意的差异：上游权威对局的成员表在 `MatchHandler` 里、列表在 `matchRegistry` 里、
 * 标签在 bluge 索引里，三处各自更新；本项目全部收敛到这个 DO，并且**顺手把
 * `match_record`（列表端点的数据源）同步一次**，于是 `GET /v2/match` 看到的 size
 * 与成员表永远一致（ECN-0011 偏差 2）。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_match.go::Pipeline.matchJoin
 * 契约源: server/pipeline_match.go::Pipeline.matchLeave
 * 契约源: server/pipeline_match.go::Pipeline.matchDataSend
 * 契约源: server/match_presence.go::MatchPresenceList.Join
 *
 * REQ-0001-018
 */

import type { Bindings } from "../env";
import { routeRelayedData } from "../domain/match/data";
import { formatMatchId } from "../domain/match/ids";
import { deleteMatchRecord, upsertMatchRecord } from "../domain/match/store";
import { ackEnvelope } from "../realtime/errors";
import { matchDataEnvelope, matchEnvelope, matchPresenceEventEnvelope, type MatchOpResult } from "../realtime/match";
import type { MatchMembers } from "./match-members";
import { broadcastTo, deliverTo, presenceOf, presencesOf } from "./match-roster";
import {
  notFound,
  silent,
  type DataInput,
  type JoinInput,
  type LeaveInput,
  type MatchMeta,
} from "./match-shapes";

export type { DataInput, JoinInput, LeaveInput, MatchMeta } from "./match-shapes";

export class MatchCore {
  constructor(
    private readonly env: Bindings,
    private readonly tenantId: string,
    private readonly matchUuid: string,
    private readonly members: MatchMembers,
    private readonly now: () => number = () => Date.now(),
  ) {}

  meta(): MatchMeta | undefined {
    const row = this.members.meta();
    if (row === undefined) return undefined;
    return {
      authoritative: row.authoritative !== 0,
      label: row.label === null ? undefined : row.label,
      node: row.node,
      createTime: row.create_time,
    };
  }

  memberCount(): number {
    return this.members.count();
  }

  /** 权威对局对外可见的 id：`<uuid>.<node>`（上游 `MatchHandler.idStr`）。 */
  canonicalId(node: string): string {
    return formatMatchId(this.matchUuid, node);
  }

  /** 创建（幂等）：已经有了就只更新标签与权威位（上游 `UpdateMatchLabel` 的语义）。 */
  async create(input: {
    readonly authoritative: boolean;
    readonly label: string | undefined;
    readonly node: string;
  }): Promise<void> {
    const existing = this.meta();
    this.members.setMeta({
      authoritative: input.authoritative ? 1 : 0,
      label: input.label ?? null,
      node: input.node,
      create_time: existing?.createTime ?? Math.floor(this.now() / 1000),
    });
    await this.#syncRecord();
  }

  /**
   * 只改标签（上游运行时的 `nk.match_set_label` → `UpdateMatchLabel`）。
   * M8 接通运行时之前，这条路由是给测试与运维留的对账位。
   */
  async setLabel(label: string | undefined): Promise<void> {
    const meta = this.meta();
    if (meta === undefined) return;
    this.members.setMeta({
      authoritative: meta.authoritative ? 1 : 0,
      label: label ?? null,
      node: meta.node,
      create_time: meta.createTime,
    });
    await this.#syncRecord();
  }

  /**
   * `match_create`：建一场中继对局**并把发起人放进去**（上游那一段 `tracker.Track`）。
   *
   * 回执的 `size` 有一条只在 `match_create` 上成立的怪规则，不能与 `match_join` 共用：
   * 没给 `name` 时上游把 size 写死成 **1**（它压根没去数成员，`presences` 也不设）；
   * 给了 `name` 时 size 是**含自己**的成员数，而 `presences` 仍然不含自己。
   */
  async createRelayed(input: {
    readonly cid: string;
    readonly matchId: string;
    readonly sessionId: string;
    readonly userId: string;
    readonly username: string;
    readonly named: boolean;
  }): Promise<MatchOpResult> {
    await this.create({ authoritative: false, label: undefined, node: "" });
    const isNew = this.members.find(input.sessionId) === undefined;
    if (isNew) {
      this.members.insert({
        session_id: input.sessionId,
        user_id: input.userId,
        username: input.username,
        node: "",
        joined_at: this.now(),
      });
      await this.#syncRecord();
    }
    const self = presenceOf(input.sessionId, input.userId, input.username, "");
    const all = presencesOf(this.members);
    const others = all.filter((presence) => !(isNew && presence.sessionId === input.sessionId));
    if (isNew) {
      await this.#broadcast(matchPresenceEventEnvelope(input.matchId, [self], []), input.sessionId);
    }
    return {
      ok: true,
      replies: [
        matchEnvelope(input.cid, {
          matchId: input.matchId,
          authoritative: false,
          label: undefined,
          size: input.named ? all.length : 1,
          presences: others,
          self,
        }),
      ],
    };
  }

  async join(input: JoinInput): Promise<MatchOpResult> {
    let meta = this.meta();
    if (meta === undefined) {
      // token 分支允许"对局还不存在"——那就按中继对局建出来（上游 tracker 隐式建流）。
      if (!input.allowEmpty || input.node !== "") return notFound();
      await this.create({ authoritative: false, label: undefined, node: "" });
      meta = this.meta() as MatchMeta;
    }
    // 节点不匹配 = 这个 id 指的不是我这一场（上游 `JoinAttempt` 的 `node != r.node`）。
    if (meta.node !== input.node) return notFound();

    const isNew = this.members.find(input.sessionId) === undefined;
    if (isNew) {
      this.members.insert({
        session_id: input.sessionId,
        user_id: input.userId,
        username: input.username,
        node: meta.node,
        joined_at: this.now(),
      });
      await this.#syncRecord();
    }

    const self = presenceOf(input.sessionId, input.userId, input.username, meta.node);
    // 上游：**刚刚加入**的人不出现在"已有成员"快照里；老成员重复 join 时会出现（含自己）。
    const presences = presencesOf(this.members).filter(
      (presence) => !(isNew && presence.sessionId === input.sessionId),
    );
    if (isNew) {
      await this.#broadcast(matchPresenceEventEnvelope(input.matchId, [self], []), input.sessionId);
    }

    return {
      ok: true,
      replies: [
        matchEnvelope(input.cid, {
          matchId: input.matchId,
          authoritative: meta.authoritative,
          label: meta.label,
          size: presences.length,
          presences,
          self,
        }),
      ],
    };
  }

  async leave(input: LeaveInput): Promise<MatchOpResult> {
    await this.leaveSession(input.sessionId);
    // 上游：`Untrack` 永远"成功"，哪怕这个人本来就不在（回一个只有 cid 的空信封）。
    return { ok: true, replies: [ackEnvelope(input.cid)] };
  }

  /** 连接关闭时的清理（上游 `UntrackAll` 里对局的那一半）。幂等。 */
  async leaveSession(sessionId: string): Promise<void> {
    const removed = this.members.delete(sessionId);
    if (removed === undefined) return;
    await this.#syncRecord();
    const meta = this.meta();
    if (meta === undefined) return;
    const leaf = presenceOf(removed.session_id, removed.user_id, removed.username, removed.node);
    // 事件里的 match id 用**规范形**（上游 tracker 拼的就是 `subject.label`）。
    await this.#broadcast(matchPresenceEventEnvelope(this.canonicalId(meta.node), [], [leaf]), sessionId);
  }

  async dataSend(input: DataInput): Promise<MatchOpResult> {
    const meta = this.meta();
    if (meta === undefined || meta.node !== input.node) return silent();
    const all = presencesOf(this.members);

    if (meta.authoritative) {
      // 权威对局：成员之外的人发不了；成员发的消息回显给他自己（上游 BroadcastMessage）。
      if (this.members.find(input.sessionId) === undefined) return silent();
      const frame = matchDataEnvelope(
        this.canonicalId(meta.node),
        presenceOf(input.sessionId, input.userId, input.username, meta.node),
        input.opCode,
        input.data,
        input.reliable,
      );
      await deliverTo(this.env, this.tenantId, all, frame);
      return { ok: true, replies: [] };
    }

    // 中继对局：过滤与"不回显发送者"的规则全在 routeRelayedData 里（它是纯函数）。
    // 两侧的大小写归一化也在那个函数里做（上游比的是 16 字节的 uuid）。
    const route = routeRelayedData(input.sessionId, all, input.filters);
    if (!route.senderFound) return silent();
    if (route.recipients.length === 0) return { ok: true, replies: [] };
    const byId = new Map(all.map((presence) => [presence.sessionId, presence]));
    const frame = matchDataEnvelope(
      input.matchId,
      presenceOf(input.sessionId, input.userId, input.username, meta.node),
      input.opCode,
      input.data,
      input.reliable,
    );
    for (const recipient of route.recipients) {
      const original = byId.get(recipient.sessionId);
      if (original === undefined) continue;
      await deliverTo(this.env, this.tenantId, [original], frame);
    }
    return { ok: true, replies: [] };
  }

  /** 广播给"除了某条会话之外"的全部成员。 */
  async #broadcast(frame: Parameters<typeof deliverTo>[3], exceptSessionId: string): Promise<void> {
    await broadcastTo(this.env, this.tenantId, presencesOf(this.members), exceptSessionId, frame);
  }

  /**
   * 把成员数同步到 `match_record`（列表端点读的那张表）。
   *
   * 失败只记日志：D1 抖一下不该让"我已经进了这场对局"这件事失败——成员表才是权威，
   * 列表少一条是可见的小偏差，而把一次成功的 join 变成 500 是不可接受的。
   */
  async #syncRecord(): Promise<void> {
    const meta = this.meta();
    if (meta === undefined) return;
    const matchId = this.canonicalId(meta.node);
    try {
      // 中继对局"没人了"就等于这场对局结束（上游 tracker 会把这个流整个收掉）；
      // 权威对局由 handler 决定何时结束，空成员时仍然留在目录里。
      if (meta.authoritative !== true && this.members.count() === 0) {
        await deleteMatchRecord(this.env.DB, this.tenantId, matchId);
        return;
      }
      await upsertMatchRecord(this.env.DB, this.tenantId, {
        matchId,
        node: meta.node,
        authoritative: meta.authoritative,
        label: meta.label ?? "",
        size: this.members.count(),
        createTime: meta.createTime,
      });
    } catch (error) {
      console.error("对局目录同步失败", error);
    }
  }
}
