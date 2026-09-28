import { create } from "@bufbuild/protobuf";
import { env } from "cloudflare:test";

import {
  ChannelJoinSchema,
  EnvelopeSchema,
  PingSchema,
  StatusFollowSchema,
  StatusUnfollowSchema,
  StatusUpdateSchema,
  type Envelope,
} from "../../src/proto/realtime_pb";
import { RpcSchema } from "../../src/proto/api/api_pb";
import type { PipelineContext, PipelineResult, StatusService } from "../../src/realtime/pipeline";
import type { PresenceSnapshot } from "../../src/realtime/presence";

/**
 * M3 实时套件的共享工装：造用户、造帧、记下管线对注册表说过什么。
 *
 * 文件名不带 `.test.ts`，不会被 vitest 收集（见 `vitest.config.ts` 的 include）。
 */

/** 直接写 `users` 表：测试要的是"这个账号存在"这个事实，不必走一遍注册流程。 */
export async function insertUser(tenantId: string, id: string, username: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO users (tenant_id, id, username, create_time, update_time) VALUES (?1, ?2, ?3, ?4, ?4)",
  )
    .bind(tenantId, id, username, now)
    .run();
}

/**
 * 固定的用户 id。用大写标准形，与身份域写入 `users.id` 的写法一致
 * （`normalizeUserId` 的规范化输出也是这个形状）。
 */
export const CALLER_ID = "C0000000-0000-4000-8000-000000000001";
export const CALLER_USERNAME = "caller";
export const PEER_ID = "C0000000-0000-4000-8000-000000000002";
export const PEER_USERNAME = "peer";
/** 形状合法但库里**没有**的账号：上游对它的处理是"忽略，不报错"。 */
export const ABSENT_ID = "C0000000-0000-4000-8000-0000000000FF";

export function pingEnvelope(cid: string): Envelope {
  return create(EnvelopeSchema, { cid, message: { case: "ping", value: create(PingSchema, {}) } });
}

export function statusFollowEnvelope(
  cid: string,
  input: { readonly userIds?: readonly string[]; readonly usernames?: readonly string[] } = {},
): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: {
      case: "statusFollow",
      value: create(StatusFollowSchema, {
        userIds: [...(input.userIds ?? [])],
        usernames: [...(input.usernames ?? [])],
      }),
    },
  });
}

export function statusUnfollowEnvelope(cid: string, userIds: readonly string[]): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: { case: "statusUnfollow", value: create(StatusUnfollowSchema, { userIds: [...userIds] }) },
  });
}

/** `status` 省略 = 上游的"把 status 包装类型留空"，语义是下线。 */
export function statusUpdateEnvelope(cid: string, status?: string): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: { case: "statusUpdate", value: create(StatusUpdateSchema, status === undefined ? {} : { status }) },
  });
}

/** 一个 M3 还没接通的频道消息，用来验证"未接通类型"的行为。 */
export function channelJoinEnvelope(cid: string): Envelope {
  return create(EnvelopeSchema, {
    cid,
    message: { case: "channelJoin", value: create(ChannelJoinSchema, { target: "room-1", type: 1 }) },
  });
}

/** 一个 RPC 帧：M6 会接通，M3 阶段是占位。 */
export function rpcEnvelope(cid: string): Envelope {
  return create(EnvelopeSchema, { cid, message: { case: "rpc", value: create(RpcSchema, { id: "r1" }) } });
}

export interface RecordedFollow {
  readonly sessionId: string;
  readonly userIds: readonly string[];
}

export interface RecordedPublish {
  readonly sessionId: string;
  readonly userId: string;
  readonly username: string;
  readonly status: string | null;
}

export interface RecordedStatus {
  readonly service: StatusService;
  readonly follows: RecordedFollow[];
  readonly unfollows: RecordedFollow[];
  readonly publishes: RecordedPublish[];
}

/** 假的注册表：把调用原样记下来，并按需返回一份固定的 presence 快照。 */
export function recordingStatus(snapshot: readonly PresenceSnapshot[] = []): RecordedStatus {
  const follows: RecordedFollow[] = [];
  const unfollows: RecordedFollow[] = [];
  const publishes: RecordedPublish[] = [];
  return {
    follows,
    unfollows,
    publishes,
    service: {
      async follow(sessionId, userIds) {
        follows.push({ sessionId, userIds: [...userIds] });
        return snapshot;
      },
      async unfollow(sessionId, userIds) {
        unfollows.push({ sessionId, userIds: [...userIds] });
      },
      async publish(sessionId, userId, username, status) {
        publishes.push({ sessionId, userId, username, status });
      },
    },
  };
}

export function pipelineContext(
  tenantId: string,
  status: StatusService,
  overrides: Partial<PipelineContext> = {},
): PipelineContext {
  return {
    db: env.DB,
    tenantId,
    sessionId: "session-under-test",
    userId: CALLER_ID,
    username: CALLER_USERNAME,
    status,
    ...overrides,
  };
}

/** 把错误帧拆成 `{code, message}`，非错误帧直接抛错（免得断言写歪了还通过）。 */
export function errorOf(envelope: Envelope): { code: number; message: string } {
  if (envelope.message.case !== "error") {
    throw new Error(`期望一帧 error，实际是 ${envelope.message.case ?? "(空)"}`);
  }
  return { code: envelope.message.value.code, message: envelope.message.value.message };
}

/**
 * "恰好一条"的取值辅助。
 *
 * `noUncheckedIndexedAccess` 开着，`replies[0]` 的类型是 `Envelope | undefined`；
 * 与其在每处断言里写 `!`，不如让"数量不对"这件事在取值时就炸出来——顺带把
 * "回帧多了/少了"也变成失败信息的一部分。
 */
export function sole<T>(items: readonly T[], what = "元素"): T {
  const [first] = items;
  if (items.length !== 1 || first === undefined) {
    throw new Error(`期望恰好一个${what}，实际 ${items.length} 个`);
  }
  return first;
}

export function onlyReply(result: PipelineResult): Envelope {
  return sole(result.replies, "回帧");
}

/** 取 `Status{presences}` 里的 `(userId, sessionId, status)` 三元组，方便整表比对。 */
export function presenceKeys(envelope: Envelope): string[] {
  if (envelope.message.case !== "status") {
    throw new Error(`期望一帧 status，实际是 ${envelope.message.case ?? "(空)"}`);
  }
  return envelope.message.value.presences.map(
    (presence) => `${presence.userId}/${presence.sessionId}/${presence.status}`,
  );
}
