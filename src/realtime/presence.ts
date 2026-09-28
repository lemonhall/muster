/**
 * 在线状态（presence）的线格式与内部快照。
 *
 * 上游把 presence 放在 tracker 里，按 stream 组织；本项目把同一份信息放在每租户一个的
 * 会话注册表 DO 里（M3 的存储替换，见 ECN-0006），但**对客户端可见的形状必须一致**：
 *
 * - `Status{presences:[...]}` 是 `status_follow` 的回执（当前在线的被关注者）；
 * - `StatusPresenceEvent{joins, leaves}` 是后续的上下线通知；
 * - 每个 `UserPresence` 带 `user_id` / `session_id` / `username` / `status`。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_status.go::Pipeline.statusFollow
 * 契约源: server/pipeline_status.go::Pipeline.statusUpdate
 */

import { create } from "@bufbuild/protobuf";

import {
  EnvelopeSchema,
  StatusPresenceEventSchema,
  StatusSchema,
  UserPresenceSchema,
  type Envelope,
} from "../proto/realtime_pb";

/** 一条在线状态快照：注册表与分片之间传的就是它。 */
export interface PresenceSnapshot {
  readonly userId: string;
  readonly sessionId: string;
  readonly username: string;
  /** 客户端自己设的状态文本；没设过就是空串（上游 `PresenceMeta.Status` 的零值）。 */
  readonly status: string;
}

/** 拼一条快照。注册表与分片两边都用它，避免"字段顺序/少一个字段"这类手误。 */
export function presenceOf(
  userId: string,
  sessionId: string,
  username: string,
  status: string,
): PresenceSnapshot {
  return { userId, sessionId, username, status };
}

export function toUserPresence(snapshot: PresenceSnapshot) {
  return create(UserPresenceSchema, {
    userId: snapshot.userId,
    sessionId: snapshot.sessionId,
    username: snapshot.username,
    // 上游无论状态是否为空都会把这个包装类型**设上**（`&wrapperspb.StringValue{...}`），
    // 所以这里也始终给值，而不是"空就不设"——线格式上这是 `22 00` 与"字段缺席"的区别。
    status: snapshot.status,
  });
}

/** `status_follow` 的回执。 */
export function statusEnvelope(cid: string, presences: readonly PresenceSnapshot[]): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "status",
      value: create(StatusSchema, { presences: presences.map(toUserPresence) }),
    },
  });
}

/** 上下线通知。joins 与 leaves 至少有一边非空才有发出去的意义。 */
export function statusPresenceEventEnvelope(
  joins: readonly PresenceSnapshot[],
  leaves: readonly PresenceSnapshot[],
): Envelope {
  return create(EnvelopeSchema, {
    message: {
      case: "statusPresenceEvent",
      value: create(StatusPresenceEventSchema, {
        joins: joins.map(toUserPresence),
        leaves: leaves.map(toUserPresence),
      }),
    },
  });
}
