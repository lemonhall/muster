/**
 * 匹配器 DO：**每租户一个实例**，键是租户 id。
 *
 * 为什么每租户一个而不是每张票一个：成局是"池子里挑人"，只要池子本身是单点，
 * 选出的一组人就一定是互相看得见的（每张票一个 DO 就得引入跨实例的一致性协议）。
 * 键带租户，于是跨租户隔离由键承担（ECN-0001）。
 *
 * 与上游的形状差异（ECN-0011 偏差 1）：上游是进程内内存 + 常驻 ticker，
 * 这里是 DO 的 SQLite + 闹钟。可观测行为一致——`matchmaker_add` 回票号、
 * 成局后投递 `matchmaker_matched`、`stats` 报同一组数字——差异只在"重启之后票还在不在"。
 *
 * 契约源（机器可读）：
 * 契约源: server/matchmaker.go::LocalMatchmaker.Add
 * 契约源: server/matchmaker.go::LocalMatchmaker.RemoveSession
 * 契约源: server/matchmaker.go::LocalMatchmaker.GetStats
 *
 * REQ-0001-017
 */

import { DurableObject } from "cloudflare:workers";

import type { Bindings } from "../env";
import { MatchmakerError } from "../domain/matchmaker/errors";
import { DEFAULT_MATCHMAKER_CONFIG, MatchmakerPool, type MatchmakerConfig } from "../domain/matchmaker/pool";
import { CompletionBuffer, oldestCreateTime } from "../domain/matchmaker/stats";
import { extractOf, type AddTicketInput } from "../domain/matchmaker/types";
import { LOCAL_NODE } from "../domain/match/ids";
import { uuidV4 } from "../domain/uuid";
import { processRound } from "./matchmaker-core";
import { readHook } from "./matchmaker-hook";
import { MatchmakerStore, type StoredMatchmakerConfig } from "./matchmaker-store";

/** 上游 `config.Matchmaker.IntervalSec` 的默认值。闹钟周期只影响"最坏情况多久成局"。 */
export const MATCHMAKER_INTERVAL_MS = 15_000;

/** 反向匹配（互配）校验的毫秒预算，与上游那只看门狗定时器同义。 */
const MUTUAL_MATCH_BUDGET_MS = 5_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function configOf(stored: StoredMatchmakerConfig): MatchmakerConfig {
  return {
    maxTickets: stored.maxTickets ?? DEFAULT_MATCHMAKER_CONFIG.maxTickets,
    intervalSec: DEFAULT_MATCHMAKER_CONFIG.intervalSec,
    maxIntervals: stored.maxIntervals ?? DEFAULT_MATCHMAKER_CONFIG.maxIntervals,
    revPrecision: stored.revPrecision ?? DEFAULT_MATCHMAKER_CONFIG.revPrecision,
    revThreshold: stored.revThreshold ?? DEFAULT_MATCHMAKER_CONFIG.revThreshold,
  };
}

export class Matchmaker extends DurableObject<Bindings> {
  readonly #tenantId: string;
  readonly #store: MatchmakerStore;
  readonly #completions = new CompletionBuffer(10);
  #pool: MatchmakerPool;
  #hook = null as ReturnType<typeof readHook>;
  #intervalMs = MATCHMAKER_INTERVAL_MS;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    const name = ctx.id.name;
    if (name === undefined || name === "") throw new Error("Matchmaker 必须以租户 id 作为实例名");
    this.#tenantId = name;
    this.#store = new MatchmakerStore(ctx.storage.sql);
    this.#pool = new MatchmakerPool(DEFAULT_MATCHMAKER_CONFIG);
    ctx.blockConcurrencyWhile(async () => {
      this.#store.migrate();
      this.#restore();
    });
  }

  /** 从 SQLite 恢复：配置、钩子、池子里的票（票恢复走 `Insert` 那条"静默跳过坏行"的路）。 */
  #restore(): void {
    const stored = this.#store.config();
    this.#pool = new MatchmakerPool(configOf(stored));
    this.#intervalMs = stored.intervalMs ?? MATCHMAKER_INTERVAL_MS;
    this.#hook = this.#store.hook();
    this.#pool.insert(this.#store.tickets());
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (`${request.method} ${url.pathname}`) {
      case "POST /add":
        return await this.#add(await request.json());
      case "POST /remove":
        return await this.#remove(await request.json());
      case "POST /removeAll":
        return await this.#removeAll(await request.json());
      case "POST /stats":
        return this.#stats();
      case "POST /process":
        return await this.#processNow(await request.json());
      case "POST /hook": {
        const body = (await request.json()) as { hook: unknown };
        this.#hook = readHook(body.hook);
        this.#store.setHook(this.#hook);
        return json({ ok: true });
      }
      case "POST /config": {
        const body = (await request.json()) as { config: StoredMatchmakerConfig };
        this.#store.setConfig(body.config);
        // 换配置 = 换池子：先把票捞出来，再按新配置重建（票本身不丢）。
        const extracts = this.#pool.tickets().map(extractOf);
        this.#pool = new MatchmakerPool(configOf(body.config));
        this.#pool.insert(extracts);
        this.#intervalMs = body.config.intervalMs ?? MATCHMAKER_INTERVAL_MS;
        return json({ ok: true });
      }
      default:
        return json({ error: "not found" }, 404);
    }
  }

  /**
   * 闹钟：跑一轮成局，然后决定还要不要下一次唤醒。
   *
   * 池子空了就停掉——上游的 ticker 是常驻的，这里让它静下来（`ctx.storage.deleteAlarm()`），
   * 于是空闲租户的匹配器实例不烧时长。这是刻意的偏差，记在 ECN-0011 偏差 1。
   */
  override async alarm(): Promise<void> {
    await this.#processRound();
  }

  async #add(raw: unknown): Promise<Response> {
    const body = raw as {
      sessionId: string;
      userId: string;
      username: string;
      query: string;
      minCount: number;
      maxCount: number;
      countMultiple: number;
      stringProperties: Record<string, string>;
      numericProperties: Record<string, number>;
    };
    const ticket = uuidV4();
    const input: AddTicketInput = {
      ticket,
      presences: [
        { userId: body.userId, sessionId: body.sessionId, username: body.username, node: LOCAL_NODE },
      ],
      sessionId: body.sessionId,
      partyId: "",
      query: body.query,
      minCount: body.minCount,
      maxCount: body.maxCount,
      countMultiple: body.countMultiple,
      stringProperties: body.stringProperties,
      numericProperties: body.numericProperties,
      now: Date.now(),
    };
    try {
      const index = this.#pool.add(input);
      this.#store.insert(extractOf(index), index.createdAt);
    } catch (error) {
      if (error instanceof MatchmakerError) return json({ ok: false, failure: error.failure });
      throw error;
    }
    await this.#ensureAlarm();
    return json({ ok: true, ticket });
  }

  async #remove(raw: unknown): Promise<Response> {
    const body = raw as { sessionId: string; ticket: string };
    try {
      this.#pool.removeSession(body.sessionId, body.ticket);
    } catch (error) {
      if (error instanceof MatchmakerError) return json({ ok: false, failure: error.failure });
      throw error;
    }
    this.#store.delete([body.ticket]);
    return json({ ok: true });
  }

  /** 连接关闭时的清理（上游 `sessionWS.Close` 里的 `RemoveSessionAll`）。 */
  async #removeAll(raw: unknown): Promise<Response> {
    const body = raw as { sessionId: string };
    const removed = this.#pool.removeSessionAll(body.sessionId);
    this.#store.delete(removed);
    return json({ ok: true, removed });
  }

  #stats(): Response {
    return json({
      ticketCount: this.#pool.size,
      oldestTicketCreateTime: oldestCreateTime(this.#pool.tickets().map((index) => index.createdAt)),
      completions: this.#completions.clone(),
    });
  }

  /** 测试用的"现在就跑一轮"入口；正文与闹钟走的是同一个函数。 */
  async #processNow(raw: unknown): Promise<Response> {
    const body = (raw ?? {}) as { schedule?: boolean };
    const round = await this.#processRound();
    void body;
    return json({ ok: true, matches: round.matches, tickets: round.tickets });
  }

  async #processRound(): Promise<{ matches: number; tickets: readonly string[] }> {
    const round = await processRound(
      this.env,
      this.#tenantId,
      this.#pool,
      this.#completions,
      this.#hook,
      { now: Date.now(), mutualMatchBudgetMs: MUTUAL_MATCH_BUDGET_MS },
    );
    this.#store.delete(round.tickets);
    if (this.#pool.size > 0) await this.#ensureAlarm();
    else await this.ctx.storage.deleteAlarm();
    return round;
  }

  async #ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + this.#intervalMs);
    }
  }
}
