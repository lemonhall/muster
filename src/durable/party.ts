/**
 * 派对 DO：**一个派对一个实例**，键是 `租户|uuid`（`partyKeyOf`）。
 *
 * 为什么一个派对一个 DO：成员表、加入请求表、队长、广播顺序都要单点定序，
 * 而上游那个 `PartyHandler` 恰好就是一个带锁的单点。键里带租户，于是不同租户的
 * 同名 uuid 天然隔离（ECN-0001 在 DO 这一层由"键即隔离"承担，不需要每条 SQL
 * 再写一遍 `tenant_id`）。
 *
 * 与上游的形状差异（ECN-0013 偏差 1）：上游派对全在进程内存里（重启即丢），
 * 这里落在 DO 的 SQLite 上。**可观测行为一致**——创建、加入请求、批准、踢人、
 * 队长继任、关闭、数据广播的所有回应与广播都逐条对齐；差异只在"重启之后派对
 * 还在不在"，测试不依赖它。
 *
 * 这一层只做三件事：解析路由、把 JSON 变成 `PartyCore` 的入参、把结果编码回
 * protojson。语义在 `party-core.ts` 及其两个兄弟文件，SQL 在
 * `party-{members,requests}.ts`。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_party.go::Pipeline.partyCreate
 * 契约源: server/party_registry.go::LocalPartyRegistry.PartyJoinRequest
 *
 * REQ-0001-019
 */

import { toJson } from "@bufbuild/protobuf";
import { DurableObject } from "cloudflare:workers";

import type { Bindings } from "../env";
import { fromBase64 } from "../domain/bytes";
import type { PartyPresence } from "../domain/party/types";
import { EnvelopeSchema } from "../proto/realtime_pb";
import type { PartyOpResult } from "../realtime/party";
import { PartyCore } from "./party-core";
import { PartyMembers } from "./party-members";
import { PartyRequests } from "./party-requests";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function replyOp(result: PartyOpResult): Response {
  if (!result.ok) return json({ ok: false, failure: result.failure });
  return json({
    ok: true,
    replies: result.replies.map((envelope) => toJson(EnvelopeSchema, envelope)),
  });
}

/** 跨 DO 边界的 presence：四件套（含节点，派对里节点是成员表的一部分）。 */
interface PresenceBody {
  readonly userId: string;
  readonly sessionId: string;
  readonly username: string;
  readonly node: string;
}

function presenceOf(body: PresenceBody): PartyPresence {
  return {
    userId: body.userId,
    sessionId: body.sessionId,
    username: body.username,
    node: body.node,
  };
}

export class Party extends DurableObject<Bindings> {
  readonly #uuid: string;
  readonly #core: PartyCore;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    const name = ctx.id.name;
    if (name === undefined || name === "") throw new Error("Party 必须以 `租户|uuid` 作为实例名");
    const separator = name.indexOf("|");
    if (separator <= 0 || separator === name.length - 1) {
      throw new Error("Party 的实例名必须是 `租户|uuid`");
    }
    const tenantId = name.slice(0, separator);
    this.#uuid = name.slice(separator + 1);
    const members = new PartyMembers(ctx.storage.sql);
    const requests = new PartyRequests(ctx.storage.sql);
    this.#core = new PartyCore(env, tenantId, this.#uuid, members, requests);
    ctx.blockConcurrencyWhile(async () => {
      members.migrate();
      requests.migrate();
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await readJsonBody(request) : undefined;
    switch (`${request.method} ${url.pathname}`) {
      case "POST /create":
        return replyOp(await this.#core.create(readCreate(body)));
      case "POST /join":
        return replyOp(await this.#core.join(readJoin(body)));
      case "POST /leave":
        return replyOp(await this.#core.leave(readClose(body)));
      case "POST /promote":
        return replyOp(await this.#core.promote({ ...readClose(body), presence: presenceOf(presenceBody(body)) }));
      case "POST /accept":
        return replyOp(await this.#core.accept({ ...readClose(body), presence: presenceOf(presenceBody(body)) }));
      case "POST /remove":
        return replyOp(await this.#core.remove({ ...readClose(body), presence: presenceOf(presenceBody(body)) }));
      case "POST /close":
        return replyOp(await this.#core.close(readClose(body)));
      case "POST /requests":
        return replyOp(
          await this.#core.joinRequestList({ ...readClose(body), rawPartyId: String(bodyOf(body)["rawPartyId"] ?? "") }),
        );
      case "POST /data":
        return replyOp(await this.#core.dataSend(readData(body)));
      case "POST /update":
        return replyOp(await this.#core.update(readUpdate(body)));
      case "POST /matchmakerAdd":
        return replyOp(await this.#core.matchmakerAdd(readMatchmakerAdd(body)));
      case "POST /matchmakerRemove":
        return replyOp(await this.#core.matchmakerRemove(readMatchmakerRemove(body)));
      case "POST /leaveAll": {
        await this.#core.leaveAll(String(bodyOf(body)["sessionId"] ?? ""));
        return json({ ok: true });
      }
      case "POST /exists":
        return json({ exists: this.#core.meta() !== null });
      default:
        return json({ error: "not found" }, 404);
    }
  }
}

/**
 * 空 body 是一次合法的 POST（`/exists` 这种无参查询就是这样发的）——
 * `request.json()` 对它会抛 SyntaxError，所以先看正文长度再决定要不要解析。
 */
async function readJsonBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (raw.trim() === "") return {};
  return JSON.parse(raw);
}

function bodyOf(raw: unknown): Record<string, unknown> {
  return (raw ?? {}) as Record<string, unknown>;
}

function readCreate(raw: unknown) {
  const body = bodyOf(raw);
  return {
    cid: String(body["cid"] ?? ""),
    self: presenceOf(presenceBody(raw)),
    open: body["open"] === true,
    hidden: body["hidden"] === true,
    maxSize: Number(body["maxSize"] ?? 0),
    label: String(body["label"] ?? ""),
  };
}

function readJoin(raw: unknown) {
  const body = bodyOf(raw);
  return {
    cid: String(body["cid"] ?? ""),
    partyId: String(body["partyId"] ?? ""),
    node: String(body["node"] ?? ""),
    self: presenceOf(presenceBody(raw)),
  };
}

function readClose(raw: unknown) {
  const body = bodyOf(raw);
  return {
    cid: String(body["cid"] ?? ""),
    partyId: String(body["partyId"] ?? ""),
    node: String(body["node"] ?? ""),
    sessionId: String(body["sessionId"] ?? ""),
  };
}

function presenceBody(raw: unknown): PresenceBody {
  const body = bodyOf(raw);
  const presence = bodyOf(body["presence"] ?? body["self"]);
  return {
    userId: String(presence["userId"] ?? body["userId"] ?? ""),
    sessionId: String(presence["sessionId"] ?? body["sessionId"] ?? ""),
    username: String(presence["username"] ?? body["username"] ?? ""),
    node: String(presence["node"] ?? body["node"] ?? ""),
  };
}

function readData(raw: unknown) {
  const body = bodyOf(raw);
  return {
    cid: String(body["cid"] ?? ""),
    partyId: String(body["partyId"] ?? ""),
    node: String(body["node"] ?? ""),
    sessionId: String(body["sessionId"] ?? ""),
    // int64 不能进 JSON，用十进制字符串过边界；bytes 用标准 base64。
    opCode: BigInt(String(body["opCode"] ?? "0")),
    data: fromBase64(String(body["data"] ?? "")),
  };
}

function readUpdate(raw: unknown) {
  const body = bodyOf(raw);
  return {
    ...readClose(raw),
    label: String(body["label"] ?? ""),
    open: body["open"] === true,
    hidden: body["hidden"] === true,
  };
}

function readMatchmakerAdd(raw: unknown) {
  const body = bodyOf(raw);
  return {
    ...readClose(raw),
    rawPartyId: String(body["rawPartyId"] ?? ""),
    query: String(body["query"] ?? ""),
    minCount: Number(body["minCount"] ?? 0),
    maxCount: Number(body["maxCount"] ?? 0),
    countMultiple: Number(body["countMultiple"] ?? 1),
    stringProperties: (body["stringProperties"] ?? {}) as Record<string, string>,
    numericProperties: (body["numericProperties"] ?? {}) as Record<string, number>,
  };
}

function readMatchmakerRemove(raw: unknown) {
  const body = bodyOf(raw);
  return { ...readClose(raw), ticket: String(body["ticket"] ?? "") };
}
