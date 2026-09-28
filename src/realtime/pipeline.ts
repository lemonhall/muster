/**
 * 入站帧的分发：把一条 `Envelope` 变成"要回什么 + 要不要关连接"。
 *
 * 这一层是纯逻辑（除了查用户表），刻意不碰 WebSocket：分片 DO 只负责收发字节，
 * 语义判断全在这里，于是它可以在没有网络的情况下被逐条断言。
 *
 * 语义逐条对齐上游 `server/pipeline.go` 的 `ProcessRequest` 与
 * `server/pipeline_status.go`（含一个反直觉但必须复刻的行为）：
 * **多数错误之后上游会直接关掉会话**——`ProcessRequest` 返回 false 时，
 * `sessionWS.consume` 跳出读循环并 Close。所以 `BAD_INPUT`、`MISSING_PAYLOAD`、
 * `UNRECOGNIZED_PAYLOAD` 三条路都是"先发错误帧，再关连接"。
 *
 * M3 接通 `ping` / `pong` / `status_*`，M4 接通 `channel_*` 五个，M7 接通
 * `match_*` 四个与 `matchmaker_*` 两个；其余消息类型（派对、RPC……）暂时与上游
 * "没有对应处理函数"时一样走 `UNRECOGNIZED_PAYLOAD` 分支并关闭。这是**临时**行为，
 * 后续里程碑逐条替换，差异记在 ECN-0006 里。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline.go::Pipeline.ProcessRequest
 * 契约源: server/pipeline_ping.go::Pipeline.ping
 * 契约源: server/pipeline_status.go::Pipeline.statusFollow
 * 契约源: server/pipeline_status.go::Pipeline.statusUnfollow
 * 契约源: server/pipeline_status.go::Pipeline.statusUpdate
 */

import { create } from "@bufbuild/protobuf";

import { findUsersByIds, findUsersByUsernames } from "../domain/identity/store";
import { byteLength } from "../domain/identity/service/validate";
import {
  EnvelopeSchema,
  PongSchema,
  type Envelope,
  type StatusFollow,
  type StatusUnfollow,
  type StatusUpdate,
} from "../proto/realtime_pb";
import { ackEnvelope, badInputError, missingPayloadError, unrecognizedPayloadError } from "./errors";
import { normalizeUserId } from "./identifiers";
import {
  channelJoin,
  channelLeave,
  channelMessageRemove,
  channelMessageSend,
  channelMessageUpdate,
} from "./pipeline-channel";
import { matchCreate, matchDataSend, matchJoin, matchLeave } from "./pipeline-match";
import { matchmakerAdd, matchmakerRemove } from "./pipeline-matchmaker";
import { statusEnvelope, type PresenceSnapshot } from "./presence";
import type { ChannelService } from "./channel";
import type { MatchService } from "./match";
import type { MatchmakerService } from "./matchmaker";

/** 状态订阅在会话侧的样子。实现由分片 DO 提供（它去调注册表 DO）。 */
export interface StatusService {
  /** 订阅这些用户，并返回他们当前的状态快照。 */
  follow(sessionId: string, userIds: readonly string[]): Promise<readonly PresenceSnapshot[]>;
  unfollow(sessionId: string, userIds: readonly string[]): Promise<void>;
  /** `status === null` 表示"我下线"（上游对该 stream 做 Untrack）。 */
  publish(sessionId: string, userId: string, username: string, status: string | null): Promise<void>;
}

export interface PipelineContext {
  readonly db: D1Database;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly username: string;
  readonly status: StatusService;
  readonly channel: ChannelService;
  readonly matchmaker: MatchmakerService;
  readonly match: MatchService;
}

export interface PipelineResult {
  readonly replies: readonly Envelope[];
  /** true = 回完这一批就关连接（上游 `ProcessRequest` 返回 false 的等价物）。 */
  readonly close: boolean;
}

const KEEP_OPEN: PipelineResult = { replies: [], close: false };

function reply(envelope: Envelope, close = false): PipelineResult {
  return { replies: [envelope], close };
}

/** 上游 `status` 里状态文本的长度上限，单位是**字节**（Go `len(string)` 的语义）。 */
const MAX_STATUS_BYTES = 2048;

export async function handleEnvelope(
  context: PipelineContext,
  envelope: Envelope,
): Promise<PipelineResult> {
  const cid = envelope.cid;

  switch (envelope.message.case) {
    case undefined:
      return reply(missingPayloadError(cid), true);

    case "ping":
      // 上游 `pipeline_ping.go`：原样回带 cid 的 pong。
      return reply(
        create(EnvelopeSchema, { cid, message: { case: "pong", value: create(PongSchema, {}) } }),
      );

    case "pong":
      // 客户端对服务端心跳的回应，应用层不做任何事。
      return KEEP_OPEN;

    case "statusFollow":
      return statusFollow(context, cid, envelope.message.value);

    case "statusUnfollow":
      return statusUnfollow(context, cid, envelope.message.value);

    case "statusUpdate":
      return statusUpdate(context, cid, envelope.message.value);

    case "channelJoin":
      return channelJoin(context, cid, envelope.message.value);

    case "channelLeave":
      return channelLeave(context, cid, envelope.message.value);

    case "channelMessageSend":
      return channelMessageSend(context, cid, envelope.message.value);

    case "channelMessageUpdate":
      return channelMessageUpdate(context, cid, envelope.message.value);

    case "channelMessageRemove":
      return channelMessageRemove(context, cid, envelope.message.value);

    case "matchmakerAdd":
      return matchmakerAdd(context, cid, envelope.message.value);

    case "matchmakerRemove":
      return matchmakerRemove(context, cid, envelope.message.value);

    case "matchCreate":
      return matchCreate(context, cid, envelope.message.value);

    case "matchJoin":
      return matchJoin(context, cid, envelope.message.value);

    case "matchLeave":
      return matchLeave(context, cid, envelope.message.value);

    case "matchDataSend":
      return matchDataSend(context, cid, envelope.message.value);

    default:
      return reply(unrecognizedPayloadError(cid), true);
  }
}

async function statusFollow(
  context: PipelineContext,
  cid: string,
  incoming: StatusFollow,
): Promise<PipelineResult> {
  const ids = new Set<string>();
  for (const raw of incoming.userIds) {
    const userId = normalizeUserId(raw);
    if (userId === null) return reply(badInputError(cid, "Invalid user identifier"), true);
    if (userId === context.userId) continue; // 不能关注自己
    ids.add(userId);
  }

  const usernames = new Set<string>();
  for (const raw of incoming.usernames) {
    if (raw === "") return reply(badInputError(cid, "Invalid username"), true);
    if (raw === context.username) continue;
    usernames.add(raw);
  }

  if (ids.size === 0 && usernames.size === 0) return reply(statusEnvelope(cid, []));

  // 只订阅"确实存在的账号"：上游先把 id/username 拿去查库，查不到的既不订阅也不报错。
  const found = new Set<string>();
  if (ids.size > 0) {
    for (const user of await findUsersByIds(context.db, context.tenantId, [...ids])) found.add(user.id);
  }
  if (usernames.size > 0) {
    for (const user of await findUsersByUsernames(context.db, context.tenantId, [...usernames])) {
      found.add(user.id);
    }
  }

  const presences = await context.status.follow(context.sessionId, [...found]);
  return reply(statusEnvelope(cid, presences));
}

async function statusUnfollow(
  context: PipelineContext,
  cid: string,
  incoming: StatusUnfollow,
): Promise<PipelineResult> {
  if (incoming.userIds.length === 0) return reply(ackEnvelope(cid));

  const ids: string[] = [];
  for (const raw of incoming.userIds) {
    const userId = normalizeUserId(raw);
    if (userId === null) return reply(badInputError(cid, "Invalid user identifier"), true);
    if (userId === context.userId) continue; // 本来就没关注自己
    ids.push(userId);
  }

  await context.status.unfollow(context.sessionId, ids);
  return reply(ackEnvelope(cid));
}

async function statusUpdate(
  context: PipelineContext,
  cid: string,
  incoming: StatusUpdate,
): Promise<PipelineResult> {
  if (incoming.status === undefined) {
    await context.status.publish(context.sessionId, context.userId, context.username, null);
    return reply(ackEnvelope(cid));
  }

  // `status` 在生成物里是 `google.protobuf.StringValue` 的映射：值直接就是 string，
  // "设没设过"由 `undefined` 表示。别写成 `incoming.status.value`——那是包装类型的
  // Go 形状，在 TS 生成物上会读到 undefined，长度检查就整体失效了。
  if (byteLength(incoming.status) > MAX_STATUS_BYTES) {
    return reply(badInputError(cid, "Status must be 2048 characters or less"), true);
  }

  await context.status.publish(context.sessionId, context.userId, context.username, incoming.status);
  return reply(ackEnvelope(cid));
}
