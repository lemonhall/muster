/**
 * 对局在实时协议上的形状：`match` / `match_presence_event` / `match_data` 三种帧，
 * 以及对局域对管线暴露的服务接口。
 *
 * 三种帧的字段都来自上游 `rtapi`，但有两条容易抄错的地方：
 *
 * 1. `match.label` 是 `google.protobuf.StringValue`：**权威对局**的 join 回执一定带它
 *    （哪怕是空串，因为上游赋的是 `&wrapperspb.StringValue{Value: l}`），而
 *    `match_create` 与中继对局的 join 回执**不带**（上游没设这个字段）。
 *    protojson 会把空串的包装类型发成 `"label": ""`，两者在客户端看得见地不同；
 * 2. `match_presence_event` **没有 cid**（它是广播，不是应答）。
 *
 * 失败形状有四种，比频道多一种：
 *   - `invalid`：`BAD_INPUT`（调用方负责给文案，因为它分两条）；
 *   - `not-found`：`MATCH_NOT_FOUND` + `Match not found`；
 *   - `rejected`：`MATCH_JOIN_REJECTED` + 服务端给的理由（空则用默认文案）；
 *   - `silent`：上游 `return false, nil`——**不发任何帧**，直接关连接。
 *     这是 `match_data_send` 的"发送者不是成员"那一支，与"发错误帧再关"不同。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_match.go::Pipeline.matchCreate
 * 契约源: server/pipeline_match.go::Pipeline.matchJoin
 * 契约源: server/pipeline_match.go::Pipeline.matchLeave
 * 契约源: server/pipeline_match.go::Pipeline.matchDataSend
 *
 * REQ-0001-018
 */

import { create } from "@bufbuild/protobuf";

import {
  EnvelopeSchema,
  MatchDataSchema,
  MatchPresenceEventSchema,
  MatchSchema,
  UserPresenceSchema,
  type Envelope,
} from "../proto/realtime_pb";
import type { MatchPresence } from "../domain/match/presence";
import type { MatchDataFilter } from "../domain/match/data";

/** 对局帧里的 presence：上游 `UserPresence` 只有这三个字段（对局里没有 status/persistence）。 */
export function toUserPresence(presence: MatchPresence) {
  return create(UserPresenceSchema, {
    userId: presence.userId,
    sessionId: presence.sessionId,
    username: presence.username,
  });
}

export interface MatchInfo {
  readonly matchId: string;
  readonly authoritative: boolean;
  /** `undefined` = 不带 label 字段（中继 / `match_create`）；字符串（含空串）= 带上。 */
  readonly label: string | undefined;
  readonly size: number;
  readonly presences: readonly MatchPresence[];
  readonly self: MatchPresence;
}

export function matchEnvelope(cid: string, info: MatchInfo): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "match",
      value: create(MatchSchema, {
        matchId: info.matchId,
        authoritative: info.authoritative,
        ...(info.label === undefined ? {} : { label: info.label }),
        size: info.size,
        presences: info.presences.map(toUserPresence),
        self: toUserPresence(info.self),
      }),
    },
  });
}

export function matchPresenceEventEnvelope(
  matchId: string,
  joins: readonly MatchPresence[],
  leaves: readonly MatchPresence[],
): Envelope {
  return create(EnvelopeSchema, {
    message: {
      case: "matchPresenceEvent",
      value: create(MatchPresenceEventSchema, {
        matchId,
        joins: joins.map(toUserPresence),
        leaves: leaves.map(toUserPresence),
      }),
    },
  });
}

export function matchDataEnvelope(
  matchId: string,
  sender: MatchPresence,
  opCode: bigint,
  data: Uint8Array,
  reliable: boolean,
): Envelope {
  return create(EnvelopeSchema, {
    message: {
      case: "matchData",
      value: create(MatchDataSchema, {
        matchId,
        presence: toUserPresence(sender),
        opCode,
        data,
        reliable,
      }),
    },
  });
}

/**
 * `match_create` 的入参：match id 已经由管线定好。
 *
 * 为什么派生（v5）与随机（v4）这件事留在管线而不是服务层：上游就是在
 * `pipeline_match.go::matchCreate` 里做的，而且它决定了对外可见的 `match_id`
 * （带名字的创建必须可复现），属于协议语义，属于能被逐条断言的那一层。
 */
export interface MatchCreateInput {
  readonly cid: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly username: string;
  /** 完整的 `<uuid>.`（中继对局的 node 段是空串）。 */
  readonly matchId: string;
  /**
   * 客户端是否给了 `name`。它决定回执里的 `size`：上游在"没给名字"时把 size 写死成 1、
   * `presences` 整个不设；给了名字才去数成员（`size` 含自己、`presences` 不含自己）。
   */
  readonly named: boolean;
}

/** `match_join`：管线已把 id 或 token 解成了 match id。 */
export interface MatchJoinInput {
  readonly cid: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly username: string;
  readonly matchId: string;
  /** `allow_empty = true`（token 分支）：对局不存在时**创建**流，而不是 `Match not found`。 */
  readonly allowEmpty: boolean;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface MatchLeaveInput {
  readonly cid: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly username: string;
  readonly matchId: string;
}

export interface MatchDataSendInput {
  readonly sessionId: string;
  readonly userId: string;
  readonly username: string;
  readonly matchId: string;
  readonly opCode: bigint;
  readonly data: Uint8Array;
  readonly reliable: boolean;
  readonly filters: readonly MatchDataFilter[];
}

export type MatchOpFailure =
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "silent" };

export type MatchOpResult =
  | { readonly ok: true; readonly replies: readonly Envelope[] }
  | { readonly ok: false; readonly failure: MatchOpFailure };

export interface MatchService {
  /**
   * 校验 `match_join` 的加入令牌并解出 mid；验不过（签名、`exp`、形状）返回 null。
   *
   * 放在服务接口里而不是管线里，是因为它需要租户派生密钥（只有拿着 `env` 的那一层
   * 有）；而"失败报什么文案"仍然由管线决定——这正是这条分界线的意义。
   */
  resolveToken(token: string): Promise<string | null>;
  create(input: MatchCreateInput): Promise<MatchOpResult>;
  join(input: MatchJoinInput): Promise<MatchOpResult>;
  leave(input: MatchLeaveInput): Promise<MatchOpResult>;
  dataSend(input: MatchDataSendInput): Promise<MatchOpResult>;
}
