/**
 * 会话注册表 DO：**每租户一个实例**，记录"谁在线、谁在关注谁"，并负责把
 * 上下线事件推给关注者所在的分片。存储细节在 `session-store.ts`。
 *
 * 这里替换的是上游 `LocalStatusRegistry` + `LocalTracker` 里与在线状态有关的那一半。
 * 语义**逐条对齐**上游（`server/tracker.go` + `server/status_registry.go`）：
 *
 * - presence 是**每会话**的，不是每用户的：同一用户开两条连接就有两条 presence，
 *   各自带自己的 `session_id`，因此 `status_follow` 的快照里可能出现同一个人两次
 *   （上游 `tracker.ListByStream` 就是这么返回的）；
 * - 事件按"被关注用户"分组，只发给**关注了该用户**的会话；
 * - `status_update`（有值）在已经在线时，会同时产生 `joins:[新]` 与 `leaves:[旧]`——
 *   这是上游 `tracker.Update` 的行为（它把旧 presence 换掉并各发一条）；
 * - `status_update`（空值）等价于下线（上游对该 stream 做 `Untrack`）。
 *
 * 与上游的差异只有"存在哪里"：上游是两张进程内 map，这里是 DO 的 SQLite。
 * 进程内 map 在多机部署时会丢事件，DO 的单实例串行化反而更强——这条记在 ECN-0006。
 *
 * 契约源（机器可读）：
 * 契约源: server/socket_ws.go::NewSocketWsAcceptor
 * 契约源: server/tracker.go::LocalTracker.Track
 * 契约源: server/tracker.go::LocalTracker.Update
 * 契约源: server/tracker.go::LocalTracker.Untrack
 * 契约源: server/status_registry.go::LocalStatusRegistry.Follow
 * 契约源: server/status_registry.go::LocalStatusRegistry.Queue
 *
 * REQ-0001-009
 */

import { DurableObject } from "cloudflare:workers";

import type { Bindings } from "../env";
import { presenceOf, type PresenceSnapshot } from "../realtime/presence";
import { shardKeyOf } from "../realtime/socket-meta";
import { SessionStore } from "./session-store";

/**
 * 多久没跟注册表打过招呼就认为会话已经不在了。
 *
 * 上游用"WS 控制帧 ping / 读超时"判活性，本项目的等价物是分片 DO 的心跳
 * （见 `session-shard.ts` 的 `SESSION_TOUCH_INTERVAL_MS`，20s 一次）。
 * 这里留 3 个心跳周期的容错，避免一次抖动就把在线的人判成离线——
 * 误判离线比晚一点发现离线更糟：关注者会收到一条错误的 leave。
 */
export const SESSION_EVICT_AFTER_MS = 60_000;
/** 巡检间隔。取值只影响"最坏情况下多久被发现"，不影响正确性。 */
export const SESSION_ALARM_INTERVAL_MS = 5_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export class SessionRegistry extends DurableObject<Bindings> {
  readonly #tenantId: string;
  readonly #store: SessionStore;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    // 实例名就是租户 id（`idFromName(tenantId)`）。拿不到名字说明绑定被误用了，
    // 与其带着空租户继续跑（会串租户），不如立刻炸掉。
    const name = ctx.id.name;
    if (name === undefined || name === "") throw new Error("SessionRegistry 必须以租户 id 作为实例名");
    this.#tenantId = name;
    this.#store = new SessionStore(ctx.storage.sql);
    ctx.blockConcurrencyWhile(async () => {
      this.#store.migrate();
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (`${request.method} ${url.pathname}`) {
      case "POST /connect":
        return await this.#connect(await request.json());
      case "POST /disconnect":
        return await this.#disconnect(await request.json());
      case "POST /follow":
        return await this.#follow(await request.json());
      case "POST /unfollow":
        return await this.#unfollow(await request.json());
      case "POST /status":
        return await this.#status(await request.json());
      case "POST /touch":
        return await this.#touch(await request.json());
      default:
        return json({ error: "not found" }, 404);
    }
  }

  async #connect(input: ConnectInput): Promise<Response> {
    this.#store.upsert(input.sessionId, input.userId, input.username, input.wantsStatus ? 1 : 0, "");
    // 上游握手时**无条件**让会话关注自己（`server/socket_ws.go` 里
    // `statusRegistry.Follow(sessionID, map[userID])` 排在 `tracker.TrackMulti` 之前），
    // 于是 `status=true` 的连接会立刻收到一条关于**自己**的 join 事件。这不是笔误而是
    // 上游既有行为（客户端 SDK 观察得到），也是后续里程碑里"自己的通知"能送达的通道，
    // 所以照抄，不顺手优化掉。
    this.#store.follow(input.sessionId, input.userId);
    if (input.wantsStatus) {
      const presence = presenceOf(input.userId, input.sessionId, input.username, "");
      await this.#emit(input.userId, [presence], []);
    }
    await this.#ensureAlarm();
    return json({ ok: true });
  }

  async #disconnect(input: SessionInput): Promise<Response> {
    const row = this.#store.find(input.sessionId);
    this.#store.remove(input.sessionId);
    if (row !== undefined && row.has_status === 1) {
      const presence = presenceOf(row.user_id, row.session_id, row.username, row.status);
      await this.#emit(row.user_id, [], [presence]);
    }
    return json({ ok: true });
  }

  async #follow(input: FollowInput): Promise<Response> {
    const presences: PresenceSnapshot[] = [];
    for (const userId of input.userIds) {
      this.#store.follow(input.sessionId, userId);
      for (const row of this.#store.listByUser(userId)) {
        presences.push(presenceOf(userId, row.session_id, row.username, row.status));
      }
    }
    presences.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    return json({ presences });
  }

  async #unfollow(input: FollowInput): Promise<Response> {
    for (const userId of input.userIds) this.#store.unfollow(input.sessionId, userId);
    return json({ ok: true });
  }

  async #status(input: StatusInput): Promise<Response> {
    const previous = this.#store.find(input.sessionId);
    const wasOnline = previous !== undefined && previous.has_status === 1;
    const leaves: PresenceSnapshot[] =
      wasOnline && previous !== undefined
        ? [presenceOf(previous.user_id, previous.session_id, previous.username, previous.status)]
        : [];

    if (input.status === null) {
      this.#store.upsert(input.sessionId, input.userId, input.username, 0, "");
      if (leaves.length > 0) await this.#emit(input.userId, [], leaves);
      return json({ ok: true });
    }

    this.#store.upsert(input.sessionId, input.userId, input.username, 1, input.status);
    const next = presenceOf(input.userId, input.sessionId, input.username, input.status);
    await this.#emit(input.userId, [next], leaves);
    return json({ ok: true });
  }

  async #touch(input: SessionInput): Promise<Response> {
    this.#store.touch(input.sessionId, Date.now());
    return json({ ok: true });
  }

  /** 兜底巡检：分片没来得及上报就消失的会话，在这里被清掉并补发 leave。 */
  override async alarm(): Promise<void> {
    for (const row of this.#store.staleBefore(Date.now() - SESSION_EVICT_AFTER_MS)) {
      this.#store.remove(row.session_id);
      if (row.has_status === 1) {
        const presence = presenceOf(row.user_id, row.session_id, row.username, row.status);
        await this.#emit(row.user_id, [], [presence]);
      }
    }
    await this.#ensureAlarm();
  }

  /** 把事件推给"关注了该用户"的那些会话所在的分片。上游对应 `statusRegistry` 的投递循环。 */
  async #emit(
    userId: string,
    joins: readonly PresenceSnapshot[],
    leaves: readonly PresenceSnapshot[],
  ): Promise<void> {
    if (joins.length === 0 && leaves.length === 0) return;
    const followers = this.#store.followersOf(userId);
    if (followers.length === 0) return;
    const body = JSON.stringify({ joins, leaves });
    await Promise.allSettled(
      followers.map((sessionId) => {
        const stub = this.env.SESSION_SHARD.get(
          this.env.SESSION_SHARD.idFromName(shardKeyOf(this.#tenantId, sessionId)),
        );
        return stub.fetch("https://shard/deliver", { method: "POST", body });
      }),
    );
  }

  async #ensureAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) await this.ctx.storage.setAlarm(Date.now() + SESSION_ALARM_INTERVAL_MS);
  }
}

interface ConnectInput {
  readonly sessionId: string;
  readonly userId: string;
  readonly username: string;
  readonly wantsStatus: boolean;
}

interface SessionInput {
  readonly sessionId: string;
}

interface FollowInput {
  readonly sessionId: string;
  readonly userIds: string[];
}

interface StatusInput extends ConnectInput {
  readonly status: string | null;
}
