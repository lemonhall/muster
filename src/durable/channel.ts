/**
 * 频道 DO：**一个频道一个实例**，键是 `租户|频道 id`。
 *
 * 为什么一个频道一个 DO（而不是每个租户一个）：频道内的消息顺序、成员快照、历史分页
 * 都要一个**单点定序**的地方，DO 天然提供了它；键里带租户则让跨租户天然隔离，
 * 不需要在每条 SQL 里再写一遍 `tenant_id`（ECN-0001 的那条规矩在 DO 这一层
 * 由"键即隔离"承担）。
 *
 * 这一层只做三件事：解析路由、把 JSON 变成 `ChannelCore` 的入参、把结果编码回
 * protojson。语义在 `channel-core.ts`，SQL 在 `channel-members.ts` /
 * `channel-messages.ts`，分页在 `channel-history.ts`。
 *
 * 闹钟是**兜底巡检**（上游没有对应物）：正常情况下连接关闭会主动上报离开，
 * 但分片被平台硬杀时那条上报不会发生，于是频道每隔一段时间问一次注册表
 * "我的成员里谁其实已经不在了"。没有成员时不排闹钟，DO 可以彻底静下来。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_channel.go::Pipeline.channelJoin
 * 契约源: server/tracker.go::LocalTracker.UntrackAll
 *
 * REQ-0001-010
 */

import { toJson } from "@bufbuild/protobuf";
import { DurableObject } from "cloudflare:workers";

import type { Bindings } from "../env";
import { EnvelopeSchema } from "../proto/realtime_pb";
import { decodeChannelCursor, cursorMatchesStream, type ChannelMessageCursor } from "../realtime/channel-cursor";
import { channelIdToStream, type ChannelStream } from "../realtime/channel-ids";
import type { ChannelOpResult } from "../realtime/channel";
import {
  channelMessageListBody,
  type ChannelMessageRecord,
} from "../wire/channel";
import { ChannelCore } from "./channel-core";
import { checkChannelReadAccess } from "./channel-access";
import { ChannelMembers } from "./channel-members";
import { ChannelMessages, type MessageRow } from "./channel-messages";

/** 巡检周期：与注册表的会话驱逐阈值同量级，最坏情况下两分钟内收敛。 */
export const CHANNEL_SWEEP_INTERVAL_MS = 60_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordOf(row: MessageRow): ChannelMessageRecord {
  return {
    messageId: row.id,
    code: row.code,
    senderId: row.sender_id,
    username: row.username,
    content: row.content,
    createTimeMs: row.create_time_ms,
    updateTimeMs: row.update_time_ms,
  };
}

export class Channel extends DurableObject<Bindings> {
  readonly #tenantId: string;
  readonly #channelId: string;
  readonly #stream: ChannelStream;
  readonly #core: ChannelCore;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    const name = ctx.id.name;
    if (name === undefined || name === "") throw new Error("Channel 必须以 `租户|频道` 作为实例名");
    const separator = name.indexOf("|");
    if (separator <= 0 || separator === name.length - 1) {
      throw new Error("Channel 的实例名必须是 `租户|频道`");
    }
    this.#tenantId = name.slice(0, separator);
    this.#channelId = name.slice(separator + 1);
    const stream = channelIdToStream(this.#channelId);
    // 键是我们自己拼的，解不出来说明有人绕过 `channelKeyOf` 直接开了个 DO：与其带着
    // 空 stream 继续服务（会把房间消息发到私聊频道上），不如立刻炸掉。
    if (stream === null) throw new Error(`非法的频道 id：${this.#channelId}`);
    this.#stream = stream;

    const members = new ChannelMembers(ctx.storage.sql);
    const messages = new ChannelMessages(ctx.storage.sql);
    this.#core = new ChannelCore(
      env,
      this.#tenantId,
      this.#channelId,
      stream,
      members,
      messages,
    );
    ctx.blockConcurrencyWhile(async () => {
      members.migrate();
      messages.migrate();
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (`${request.method} ${url.pathname}`) {
      case "POST /join": {
        const result = await this.#core.join((await request.json()) as never);
        if (result.ok) await this.#ensureAlarm();
        return this.#replyOp(result);
      }
      case "POST /leave":
        return await this.#replyLeave(await this.#core.leave((await request.json()) as never));
      case "POST /leaveAll": {
        const body = (await request.json()) as { sessionId: string };
        await this.#core.leaveAll(body.sessionId);
        await this.#retireAlarmWhenEmpty();
        return json({ ok: true });
      }
      case "POST /send":
        return this.#replyOp(await this.#core.send((await request.json()) as never));
      case "POST /update":
        return this.#replyOp(await this.#core.update((await request.json()) as never));
      case "POST /remove":
        return this.#replyOp(await this.#core.remove((await request.json()) as never));
      case "POST /list":
        return this.#list(await request.json());
      case "POST /system-message": {
        await this.#core.systemMessage((await request.json()) as never);
        return json({ ok: true });
      }
      case "POST /evict": {
        const body = (await request.json()) as { userId: string };
        await this.#core.evictUser(body.userId);
        await this.#retireAlarmWhenEmpty();
        return json({ ok: true });
      }
      case "POST /evict-all": {
        await this.#core.evictAll();
        await this.#retireAlarmWhenEmpty();
        return json({ ok: true });
      }
      case "POST /sweep":
        await this.#core.sweep();
        await this.#retireAlarmWhenEmpty();
        return json({ ok: true });
      default:
        return json({ error: "not found" }, 404);
    }
  }

  /** 巡检闹钟：清幽灵成员，然后决定还要不要下一次唤醒。 */
  override async alarm(): Promise<void> {
    await this.#core.sweep();
    if (this.#core.memberCount() === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + CHANNEL_SWEEP_INTERVAL_MS);
  }

  async #list(raw: unknown): Promise<Response> {
    const body = raw as { limit: number; forward: boolean; cursor: string; callerId: string };
    let cursor: ChannelMessageCursor | undefined;
    if (body.cursor !== "") {
      const decoded = decodeChannelCursor(body.cursor);
      // 上游把"解不出来"与"不是这个频道/不是这个方向"归成同一句话。
      if (decoded === null || !cursorMatchesStream(decoded, this.#stream, body.forward)) {
        return json({ ok: false, reason: "cursor" });
      }
      cursor = decoded;
    }
    // 先游标、后准入：顺序与上游一致（`ChannelMessagesList` 里游标那段在权限那段之前）。
    const denial = await checkChannelReadAccess(this.env, this.#tenantId, this.#stream, body.callerId);
    if (denial !== null) return json({ ok: false, reason: denial });
    const page = this.#core.list({ limit: body.limit, forward: body.forward, cursor });
    return json({
      ok: true,
      body: channelMessageListBody(this.#channelId, this.#stream, page.rows.map(recordOf), {
        next: page.nextCursor,
        prev: page.prevCursor,
        cacheable: page.cacheableCursor,
      }),
    });
  }

  #replyOp(result: ChannelOpResult): Response {
    if (!result.ok) return json({ ok: false, code: result.code, message: result.message });
    return json({
      ok: true,
      replies: result.replies.map((envelope) => toJson(EnvelopeSchema, envelope)),
      ...(result.dmRequest === undefined ? {} : { dmRequest: result.dmRequest }),
    });
  }

  async #ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + CHANNEL_SWEEP_INTERVAL_MS);
    }
  }

  /** 离开的回执：先把"要不要继续巡检"决定掉，再把结果发回去。 */
  async #replyLeave(result: ChannelOpResult): Promise<Response> {
    await this.#retireAlarmWhenEmpty();
    return this.#replyOp(result);
  }

  /**
   * 频道空了就把闹钟撤掉：没有人需要巡检，留着它只会让这个 DO 每分钟被叫醒一次
   * （上游没有对应物，因为上游的 tracker 是进程内内存，随进程消失）。
   */
  async #retireAlarmWhenEmpty(): Promise<void> {
    if (this.#core.memberCount() === 0) await this.ctx.storage.deleteAlarm();
  }
}
