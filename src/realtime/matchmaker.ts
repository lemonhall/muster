/**
 * 匹配器在实时协议上的形状：三种帧（ticket / matched / 失败）与管线的服务接口。
 *
 * 三种帧的字段全部来自上游 `rtapi`：
 *   - `matchmaker_ticket`：只有 `ticket`；
 *   - `matchmaker_matched`：`ticket` + `id` 二选一（`match_id` 或 `token`）+ `users`
 *     + `self`；**`users` 里含收件人自己**，`self` 是"这一条是发给我的"的那份；
 *   - 失败：`BAD_INPUT`（入参不合法 / 票不存在）或 `RUNTIME_EXCEPTION`（宿主错误）。
 *
 * 为什么把"服务接口"放在这里而不是管线里：管线是纯逻辑，它需要能在一个不连
 * Durable Object 的测试里被逐条断言（校验顺序与文案是契约），而真正的池子在 DO 里。
 * 形状与 `channel.ts` 的 `ChannelService` 一致。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_matchmaker.go::Pipeline.matchmakerAdd
 * 契约源: server/pipeline_matchmaker.go::Pipeline.matchmakerRemove
 *
 * REQ-0001-017
 */

import { create } from "@bufbuild/protobuf";

import {
  EnvelopeSchema,
  MatchmakerMatched_MatchmakerUserSchema,
  MatchmakerMatchedSchema,
  MatchmakerTicketSchema,
  UserPresenceSchema,
  type Envelope,
} from "../proto/realtime_pb";
import type { MatchmakerFailure } from "../domain/matchmaker/errors";

/** `matchmaker_add` 的入参：已经过了管线那三条计数校验。 */
export interface MatchmakerAddInput {
  readonly sessionId: string;
  readonly userId: string;
  readonly username: string;
  readonly query: string;
  readonly minCount: number;
  readonly maxCount: number;
  readonly countMultiple: number;
  readonly stringProperties: Readonly<Record<string, string>>;
  readonly numericProperties: Readonly<Record<string, number>>;
}

export interface MatchmakerRemoveInput {
  readonly sessionId: string;
  readonly ticket: string;
}

/** 一次匹配器操作：成功时给出票号（成局是异步的，走 `matchmaker_matched`）。 */
export type MatchmakerOpResult =
  | { readonly ok: true; readonly ticket: string }
  | { readonly ok: false; readonly failure: MatchmakerFailure };

export interface MatchmakerService {
  add(input: MatchmakerAddInput): Promise<MatchmakerOpResult>;
  /** 撤票。`ticket-not-found` 与其他失败的文案不同，由管线分别映射。 */
  remove(input: MatchmakerRemoveInput): Promise<MatchmakerOpResult>;
}

export type MatchmakerTarget =
  | { readonly kind: "matchId"; readonly value: string }
  | { readonly kind: "token"; readonly value: string };

export interface MatchmakerMatchedUser {
  readonly userId: string;
  readonly sessionId: string;
  readonly username: string;
  readonly partyId: string;
  readonly stringProperties: Readonly<Record<string, string>>;
  readonly numericProperties: Readonly<Record<string, number>>;
}

export function matchmakerTicketEnvelope(cid: string, ticket: string): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "matchmakerTicket",
      value: create(MatchmakerTicketSchema, { ticket }),
    },
  });
}

function toMatchedUser(user: MatchmakerMatchedUser) {
  return create(MatchmakerMatched_MatchmakerUserSchema, {
    presence: create(UserPresenceSchema, {
      userId: user.userId,
      sessionId: user.sessionId,
      username: user.username,
    }),
    partyId: user.partyId,
    stringProperties: { ...user.stringProperties },
    numericProperties: { ...user.numericProperties },
  });
}

/**
 * 成局帧。`self` 与 `ticket` 是**每个收件人各不相同**的字段，所以这个函数一次只造
 * 一个人的那一份（上游是在投递循环里逐个改这两个字段）。
 */
export function matchmakerMatchedEnvelope(
  target: MatchmakerTarget,
  ticket: string,
  users: readonly MatchmakerMatchedUser[],
  self: MatchmakerMatchedUser,
): Envelope {
  return create(EnvelopeSchema, {
    message: {
      case: "matchmakerMatched",
      value: create(MatchmakerMatchedSchema, {
        ticket,
        id:
          target.kind === "matchId"
            ? { case: "matchId" as const, value: target.value }
            : { case: "token" as const, value: target.value },
        users: users.map(toMatchedUser),
        self: toMatchedUser(self),
      }),
    },
  });
}
