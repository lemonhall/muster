/**
 * 对局 DO：**一场对局一个实例**，键是 `租户|uuid`（`matchKeyOf`）。
 *
 * 为什么一场一个 DO：对局内的成员快照、广播顺序、presence 事件都要一个单点定序。
 * 键里带租户，于是不同租户的同名 uuid 天然隔离（ECN-0001 的那条规矩在 DO 这一层
 * 由"键即隔离"承担，不需要每条 SQL 再写一遍 `tenant_id`）。
 *
 * `node` 段（`<uuid>.<node>`）由调用方带进来：中继对局是空串，权威对局是本项目唯一的
 * 逻辑节点 `muster`。它同时是"这个 id 指的不是我这一场"的判据（上游 `JoinAttempt`）。
 *
 * 这一层只做三件事：解析路由、把 JSON 变成 `MatchCore` 的入参、把结果编码回 protojson。
 * 语义在 `match-core.ts`，SQL 在 `match-members.ts`。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_match.go::Pipeline.matchJoin
 * 契约源: server/match_registry.go::LocalMatchRegistry.JoinAttempt
 *
 * REQ-0001-018
 */

import { toJson } from "@bufbuild/protobuf";
import { DurableObject } from "cloudflare:workers";

import type { Bindings } from "../env";
import { fromBase64 } from "../domain/bytes";
import type { MatchDataFilter } from "../domain/match/data";
import { EnvelopeSchema } from "../proto/realtime_pb";
import type { MatchOpResult } from "../realtime/match";
import { MatchCore } from "./match-core";
import { MatchMembers } from "./match-members";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function replyOp(result: MatchOpResult): Response {
  if (!result.ok) return json({ ok: false, failure: result.failure });
  return json({
    ok: true,
    replies: result.replies.map((envelope) => toJson(EnvelopeSchema, envelope)),
  });
}

export class Match extends DurableObject<Bindings> {
  readonly #tenantId: string;
  readonly #uuid: string;
  readonly #core: MatchCore;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    const name = ctx.id.name;
    if (name === undefined || name === "") throw new Error("Match 必须以 `租户|uuid` 作为实例名");
    const separator = name.indexOf("|");
    if (separator <= 0 || separator === name.length - 1) {
      throw new Error("Match 的实例名必须是 `租户|uuid`");
    }
    this.#tenantId = name.slice(0, separator);
    this.#uuid = name.slice(separator + 1);
    const members = new MatchMembers(ctx.storage.sql);
    this.#core = new MatchCore(env, this.#tenantId, this.#uuid, members);
    ctx.blockConcurrencyWhile(async () => {
      members.migrate();
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (`${request.method} ${url.pathname}`) {
      case "POST /create": {
        const body = (await request.json()) as {
          authoritative: boolean;
          label: string | null;
          node: string;
        };
        await this.#core.create({
          authoritative: body.authoritative,
          label: body.label === null ? undefined : body.label,
          node: body.node,
        });
        return json({ ok: true });
      }
      case "POST /label": {
        const body = (await request.json()) as { label: string | null };
        await this.#core.setLabel(body.label === null ? undefined : body.label);
        return json({ ok: true });
      }
      case "POST /exists":
        return json({ exists: this.#core.meta() !== undefined });
      case "POST /createRelayed":
        return replyOp(await this.#core.createRelayed((await request.json()) as never));
      case "POST /meta": {
        const meta = this.#core.meta();
        if (meta === undefined) return json({ exists: false });
        return json({
          exists: true,
          node: meta.node,
          authoritative: meta.authoritative,
          label: meta.label ?? null,
          size: this.#core.memberCount(),
        });
      }
      case "POST /join":
        return replyOp(await this.#core.join((await request.json()) as never));
      case "POST /leave":
        return replyOp(await this.#core.leave((await request.json()) as never));
      case "POST /leaveAll": {
        const body = (await request.json()) as { sessionId: string };
        await this.#core.leaveSession(body.sessionId);
        return json({ ok: true });
      }
      case "POST /data":
        return this.#data(await request.json());
      default:
        return json({ error: "not found" }, 404);
    }
  }

  /**
   * 数据帧跨 DO 边界要换两种表示：`op_code` 是 int64（bigint 不能进 JSON，用十进制字符串），
   * `data` 是 bytes（用标准 base64，与 protojson 同形）。这层转换只此一处。
   */
  async #data(raw: unknown): Promise<Response> {
    const body = raw as {
      matchId: string;
      node: string;
      sessionId: string;
      userId: string;
      username: string;
      opCode: string;
      data: string;
      reliable: boolean;
      filters: readonly MatchDataFilter[];
    };
    return replyOp(
      await this.#core.dataSend({
        matchId: body.matchId,
        node: body.node,
        sessionId: body.sessionId,
        userId: body.userId,
        username: body.username,
        opCode: BigInt(body.opCode),
        data: fromBase64(body.data),
        reliable: body.reliable,
        filters: body.filters,
      }),
    );
  }
}
