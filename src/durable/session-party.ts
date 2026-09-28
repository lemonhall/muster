/**
 * 会话分片这一侧的**派对**状态：这条会话加入过哪些派对，以及 `PartyService` 的实现。
 *
 * 与 `session-match.ts` / `session-channels.ts` 完全对称，理由也一样：上游连接结束时
 * 调用 `tracker.UntrackAll(sessionID, Update)`，靠 tracker 里"按会话索引 presence"
 * 的那张表一次性摘掉这条会话在**所有流**里的 presence。本项目把成员真相分散到了
 * 各个 DO，所以"按会话索引"的这一半只能留在分片：分片记"我加入过谁"，断开时逐条
 * 通知（重复通知是幂等的）。
 *
 * 与上游的一处**刻意差异**（ECN-0013 偏差 5）：断连时会顺手删掉这条会话在派对里的
 * 待批加入请求。上游的 `UntrackAll` 不会碰 joinRequests，于是"发过请求然后掉线"
 * 会留下一颗永远批不掉的种子——队长一批准就得到一个不会走的幽灵成员。两边都偏离，
 * 选了不留幽灵的那一边。
 *
 * 契约源（机器可读）：
 * 契约源: server/session_ws.go::sessionWS.Close
 * 契约源: server/tracker.go::LocalTracker.UntrackAll
 *
 * REQ-0001-019
 */

import type { Bindings } from "../env";
import { toBase64 } from "../domain/bytes";
import { LOCAL_NODE, parsePartyId } from "../domain/party/ids";
import type {
  PartyActor,
  PartyCloseInput,
  PartyCreateInput,
  PartyDataInput,
  PartyJoinInput,
  PartyJoinRequestListInput,
  PartyMatchmakerAddRequest,
  PartyMatchmakerRemoveInput,
  PartyOpResult,
  PartyService,
  PartyUpdateInput,
} from "../realtime/party";
import { uuidV4 } from "../domain/uuid";
import { partyLeaveAll, partyOp } from "./party-call";

export class SessionParty implements PartyService {
  constructor(
    private readonly env: Bindings,
    private readonly tenantId: string,
    private readonly sql: SqlStorage,
  ) {}

  /** 由分片在构造时通过 `blockConcurrencyWhile` 调用。 */
  migrate(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS joined_parties (
         party_id TEXT PRIMARY KEY,
         uuid     TEXT NOT NULL
       );`,
    );
  }

  async create(input: PartyCreateInput): Promise<PartyOpResult> {
    const uuid = uuidV4();
    const result = await partyOp(this.env, this.tenantId, uuid, "/create", {
      cid: input.cid,
      self: input.self,
      open: input.open,
      hidden: input.hidden,
      maxSize: input.maxSize,
      label: input.label,
    });
    if (result.ok) this.#record(uuid);
    return result;
  }

  async join(input: PartyJoinInput): Promise<PartyOpResult> {
    const parts = parsePartyId(input.partyId);
    if (parts === null) return textFailure("Invalid party ID");
    const result = await partyOp(this.env, this.tenantId, parts.uuid, "/join", {
      cid: input.cid,
      partyId: input.partyId,
      node: parts.node,
      self: input.self,
    });
    if (result.ok) this.#record(parts.uuid);
    return result;
  }

  async leave(input: PartyCloseInput): Promise<PartyOpResult> {
    const parts = parsePartyId(input.partyId);
    if (parts === null) return textFailure("Invalid party ID");
    const result = await partyOp(this.env, this.tenantId, parts.uuid, "/leave", {
      cid: input.cid,
      partyId: input.partyId,
      node: parts.node,
      sessionId: input.sessionId,
    });
    this.#forget(parts.uuid);
    return result;
  }

  async promote(input: PartyActor): Promise<PartyOpResult> {
    return await this.#actorOp(input, "/promote");
  }

  async accept(input: PartyActor): Promise<PartyOpResult> {
    return await this.#actorOp(input, "/accept");
  }

  async remove(input: PartyActor): Promise<PartyOpResult> {
    return await this.#actorOp(input, "/remove");
  }

  async close(input: PartyCloseInput): Promise<PartyOpResult> {
    const parts = parsePartyId(input.partyId);
    if (parts === null) return textFailure("Invalid party ID");
    const result = await partyOp(this.env, this.tenantId, parts.uuid, "/close", {
      cid: input.cid,
      partyId: input.partyId,
      node: parts.node,
      sessionId: input.sessionId,
    });
    if (result.ok) this.#forget(parts.uuid);
    return result;
  }

  async joinRequestList(input: PartyJoinRequestListInput): Promise<PartyOpResult> {
    const parts = parsePartyId(input.partyId);
    if (parts === null) return textFailure("Invalid party ID");
    return await partyOp(this.env, this.tenantId, parts.uuid, "/requests", {
      cid: input.cid,
      partyId: input.partyId,
      node: parts.node,
      sessionId: input.sessionId,
      rawPartyId: input.rawPartyId,
    });
  }

  async dataSend(input: PartyDataInput): Promise<PartyOpResult> {
    const parts = parsePartyId(input.partyId);
    if (parts === null) return textFailure("Invalid party ID");
    return await partyOp(this.env, this.tenantId, parts.uuid, "/data", {
      cid: input.cid,
      partyId: input.partyId,
      node: parts.node,
      sessionId: input.sessionId,
      // bigint 不能进 JSON，用十进制字符串过边界（DO 那边再 BigInt() 回来）。
      opCode: input.opCode.toString(),
      data: toBase64(input.data),
    });
  }

  async update(input: PartyUpdateInput): Promise<PartyOpResult> {
    const parts = parsePartyId(input.partyId);
    if (parts === null) return textFailure("Invalid party ID");
    return await partyOp(this.env, this.tenantId, parts.uuid, "/update", {
      cid: input.cid,
      partyId: input.partyId,
      node: parts.node,
      sessionId: input.sessionId,
      label: input.label,
      open: input.open,
      hidden: input.hidden,
    });
  }

  async matchmakerAdd(input: PartyMatchmakerAddRequest): Promise<PartyOpResult> {
    const parts = parsePartyId(input.partyId);
    if (parts === null) return textFailure("Invalid party ID");
    return await partyOp(this.env, this.tenantId, parts.uuid, "/matchmakerAdd", {
      cid: input.cid,
      partyId: input.partyId,
      node: parts.node,
      sessionId: input.sessionId,
      rawPartyId: input.rawPartyId,
      query: input.query,
      minCount: input.minCount,
      maxCount: input.maxCount,
      countMultiple: input.countMultiple,
      stringProperties: input.stringProperties,
      numericProperties: input.numericProperties,
    });
  }

  async matchmakerRemove(input: PartyMatchmakerRemoveInput): Promise<PartyOpResult> {
    const parts = parsePartyId(input.partyId);
    if (parts === null) return textFailure("Invalid party ID");
    return await partyOp(this.env, this.tenantId, parts.uuid, "/matchmakerRemove", {
      cid: input.cid,
      partyId: input.partyId,
      node: parts.node,
      sessionId: input.sessionId,
      ticket: input.ticket,
    });
  }

  /**
   * 连接结束：逐条通知本会话碰过的派对（上游 `UntrackAll` 的派对那一半）。
   * 先清清单再通知，理由与频道/对局侧一致。
   */
  async leaveAll(sessionId: string): Promise<void> {
    const rows = this.sql
      .exec<{ readonly uuid: string }>("SELECT uuid FROM joined_parties ORDER BY party_id")
      .toArray();
    this.sql.exec("DELETE FROM joined_parties");
    if (rows.length === 0) return;
    await Promise.allSettled(
      rows.map((row) => partyLeaveAll(this.env, this.tenantId, row.uuid, sessionId)),
    );
  }

  async #actorOp(input: PartyActor, path: string): Promise<PartyOpResult> {
    const parts = parsePartyId(input.partyId);
    if (parts === null) return textFailure("Invalid party ID");
    const body = {
      cid: input.cid,
      partyId: input.partyId,
      node: parts.node,
      sessionId: input.sessionId,
      presence: input.presence,
    };
    const result = await partyOp(this.env, this.tenantId, parts.uuid, path, body);
    if (result.ok) {
      this.#record(parts.uuid);
      // 被踢的人不再属于这个派对：下一次断连不需要再通知它。
      if (path === "/remove" && input.presence.sessionId === input.sessionId) {
        this.#forget(parts.uuid);
      }
    }
    return result;
  }

  #record(uuid: string): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO joined_parties (party_id, uuid) VALUES (?, ?)",
      `${uuid}.${LOCAL_NODE}`,
      uuid,
    );
  }

  #forget(uuid: string): void {
    this.sql.exec("DELETE FROM joined_parties WHERE party_id = ?", `${uuid}.${LOCAL_NODE}`);
  }
}

function textFailure(message: string): PartyOpResult {
  return { ok: false, failure: { code: "text", message } };
}
