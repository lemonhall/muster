/**
 * 派对在实时协议上的形状：九种帧 + 派对域对管线暴露的服务接口。
 *
 * 帧与字段全部来自上游 `rtapi`（`realtime.proto` 的 `Party*` 家族）。三条容易抄错：
 *
 * 1. **只有 `party_create` 的回执带 `self` / `leader` / `label` / `presences`**：
 *    上游那一段是手写的一个 `Party` 结构；而成员加入（`PartyHandler.Join`）发出的
 *    `party` 帧带 `self` / `leader` / `presences`，**不带** `label`（它没有设这个字段，
 *    protojson 里就是空串——`Party.label` 是非包装类型，省不掉但值为 `""`）；
 * 2. `party_presence_event` / `party_leader` / `party_close` 这些**广播帧没有 cid**
 *    （上游发它们时不设 `Cid`），只有应答类帧才回带 cid；
 * 3. `party_matchmaker_ticket` 会出现两次：一次带 cid 回给队长，一次**不带 cid**
 *    发给其余成员（上游 `SendToPresenceIDs` 那一支）。
 *
 * 服务接口放在这里的理由与 `match.ts` 一样：管线是纯逻辑，要能在不连 DO 的
 * 测试里被逐条断言（校验顺序与文案是契约），真正的状态在派对 DO 里。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_party.go::Pipeline.partyCreate
 * 契约源: server/party_handler.go::PartyHandler.Join
 * 契约源: server/party_handler.go::PartyHandler.DataSend
 *
 * REQ-0001-019
 */

import { create } from "@bufbuild/protobuf";

import type { PartyFailureKind } from "../domain/party/errors";
import type { PartyPresence } from "../domain/party/types";
import {
  EnvelopeSchema,
  PartyCloseSchema,
  PartyDataSchema,
  PartyJoinRequestSchema,
  PartyLeaderSchema,
  PartyMatchmakerTicketSchema,
  PartyPresenceEventSchema,
  PartySchema,
  PartyUpdateSchema,
  UserPresenceSchema,
  type Envelope,
} from "../proto/realtime_pb";

/** 派对帧里的 presence：与对局一样只有三件套（派对里没有 status / persistence）。 */
export function toUserPresence(presence: PartyPresence) {
  return create(UserPresenceSchema, {
    userId: presence.userId,
    sessionId: presence.sessionId,
    username: presence.username,
  });
}

export interface PartyInfo {
  readonly partyId: string;
  readonly open: boolean;
  readonly hidden: boolean;
  readonly maxSize: number;
  readonly self: PartyPresence;
  readonly leader: PartyPresence;
  /** 全部**真成员**（含自己）；预留位不在里面。 */
  readonly presences: readonly PartyPresence[];
  /** 只有 `party_create` 的回执带标签；成员加入的 `party` 帧里它是空串。 */
  readonly label: string | undefined;
}

export function partyEnvelope(cid: string, info: PartyInfo): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "party",
      value: create(PartySchema, {
        partyId: info.partyId,
        open: info.open,
        hidden: info.hidden,
        maxSize: info.maxSize,
        self: toUserPresence(info.self),
        leader: toUserPresence(info.leader),
        presences: info.presences.map(toUserPresence),
        label: info.label ?? "",
      }),
    },
  });
}

export function partyLeaderEnvelope(partyId: string, presence: PartyPresence): Envelope {
  return create(EnvelopeSchema, {
    message: {
      case: "partyLeader",
      value: create(PartyLeaderSchema, { partyId, presence: toUserPresence(presence) }),
    },
  });
}

export function partyCloseEnvelope(partyId: string): Envelope {
  return create(EnvelopeSchema, {
    message: { case: "partyClose", value: create(PartyCloseSchema, { partyId }) },
  });
}

export function partyJoinRequestEnvelope(
  partyId: string,
  presences: readonly PartyPresence[],
): Envelope {
  return create(EnvelopeSchema, {
    message: {
      case: "partyJoinRequest",
      value: create(PartyJoinRequestSchema, {
        partyId,
        presences: presences.map(toUserPresence),
      }),
    },
  });
}

export function partyMatchmakerTicketEnvelope(
  cid: string,
  partyId: string,
  ticket: string,
): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "partyMatchmakerTicket",
      value: create(PartyMatchmakerTicketSchema, { partyId, ticket }),
    },
  });
}

export function partyDataEnvelope(
  partyId: string,
  sender: PartyPresence,
  opCode: bigint,
  data: Uint8Array,
): Envelope {
  return create(EnvelopeSchema, {
    message: {
      case: "partyData",
      value: create(PartyDataSchema, {
        partyId,
        presence: toUserPresence(sender),
        opCode,
        data,
      }),
    },
  });
}

export function partyUpdateEnvelope(
  partyId: string,
  open: boolean,
  hidden: boolean,
  label: string,
): Envelope {
  return create(EnvelopeSchema, {
    message: {
      case: "partyUpdate",
      value: create(PartyUpdateSchema, { partyId, open, hidden, label }),
    },
  });
}

export function partyPresenceEventEnvelope(
  partyId: string,
  joins: readonly PartyPresence[],
  leaves: readonly PartyPresence[],
): Envelope {
  return create(EnvelopeSchema, {
    message: {
      case: "partyPresenceEvent",
      value: create(PartyPresenceEventSchema, {
        partyId,
        joins: joins.map(toUserPresence),
        leaves: leaves.map(toUserPresence),
      }),
    },
  });
}

/**
 * 域失败：`party` 系列的服务层错误串。
 *
 * 两个分支的区别是**文案从哪来**：`party` 用固定的 `runtime.ErrParty*` 文本，
 * `text` 用调用方拼出来的那一条（标签解析失败要带细节、匹配器失败要把匹配器自己的
 * 错误串原样带出来）。管线只负责加前缀（`Error joining party: ` 一类）。
 */
export type PartyOpFailure =
  | { readonly code: "party"; readonly reason: PartyFailureKind }
  | { readonly code: "text"; readonly message: string };

export type PartyOpResult =
  | { readonly ok: true; readonly replies: readonly Envelope[] }
  | { readonly ok: false; readonly failure: PartyOpFailure };

export interface PartyCreateInput {
  readonly cid: string;
  readonly self: PartyPresence;
  readonly open: boolean;
  readonly hidden: boolean;
  readonly maxSize: number;
  readonly label: string;
}

export interface PartyJoinInput {
  readonly cid: string;
  readonly partyId: string;
  readonly node: string;
  readonly self: PartyPresence;
}

export interface PartyActor {
  readonly cid: string;
  readonly partyId: string;
  readonly node: string;
  readonly sessionId: string;
  readonly presence: PartyPresence;
}

export interface PartyCloseInput {
  readonly cid: string;
  readonly partyId: string;
  readonly node: string;
  readonly sessionId: string;
}

export interface PartyDataInput {
  readonly cid: string;
  readonly partyId: string;
  readonly node: string;
  readonly sessionId: string;
  readonly opCode: bigint;
  readonly data: Uint8Array;
}

export interface PartyUpdateInput extends PartyCloseInput {
  readonly cid: string;
  readonly label: string;
  readonly open: boolean;
  readonly hidden: boolean;
}

export interface PartyMatchmakerAddInput extends PartyCloseInput {
  readonly cid: string;
  readonly query: string;
  readonly minCount: number;
  readonly maxCount: number;
  readonly countMultiple: number;
  readonly stringProperties: Readonly<Record<string, string>>;
  readonly numericProperties: Readonly<Record<string, number>>;
}

export interface PartyMatchmakerRemoveInput extends PartyCloseInput {
  readonly cid: string;
  readonly ticket: string;
}

/**
 * `party_join_request_list` 的入参：除 id/node/会话之外还要带上**客户端原样给的
 * 派对 id`——上游这一处回的是 `incoming.PartyId`，不是规整后的 `IDStr`。
 */
export interface PartyJoinRequestListInput extends PartyCloseInput {
  readonly rawPartyId: string;
}

/** `party_matchmaker_add` 的入参：回执与通知里的 `party_id` 同样是客户端原文。 */
export interface PartyMatchmakerAddRequest extends PartyMatchmakerAddInput {
  readonly rawPartyId: string;
}

/** 派对域对管线暴露的全部动作（每一条对应一种入站帧或一种生命周期事件）。 */
export interface PartyService {
  create(input: PartyCreateInput): Promise<PartyOpResult>;
  join(input: PartyJoinInput): Promise<PartyOpResult>;
  leave(input: PartyCloseInput): Promise<PartyOpResult>;
  promote(input: PartyActor): Promise<PartyOpResult>;
  accept(input: PartyActor): Promise<PartyOpResult>;
  remove(input: PartyActor): Promise<PartyOpResult>;
  close(input: PartyCloseInput): Promise<PartyOpResult>;
  joinRequestList(input: PartyJoinRequestListInput): Promise<PartyOpResult>;
  dataSend(input: PartyDataInput): Promise<PartyOpResult>;
  update(input: PartyUpdateInput): Promise<PartyOpResult>;
  matchmakerAdd(input: PartyMatchmakerAddRequest): Promise<PartyOpResult>;
  matchmakerRemove(input: PartyMatchmakerRemoveInput): Promise<PartyOpResult>;
  /** 连接关闭时的清理（上游 `UntrackAll` 的派对那一半）。幂等。 */
  leaveAll(sessionId: string): Promise<void>;
}
