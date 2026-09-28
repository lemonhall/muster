/**
 * 频道相关的五个入站帧：`channel_join` / `channel_leave` / `channel_message_send` /
 * `channel_message_update` / `channel_message_remove`。
 *
 * 这里是**校验顺序**的权威（上游 `server/pipeline_channel.go` 逐行照抄），因为顺序本身
 * 是可观测契约：客户端拿到哪条错误取决于先撞上哪个检查。
 *
 * | 帧 | 校验顺序 |
 * |---|---|
 * | join | 频道 id 形状（含目标）→ DM/群组的查库权限 → 成员表 |
 * | leave | 频道 id 形状 → 成员表 |
 * | send | 频道 id 形状 → content 是 JSON 对象 → 成员表 |
 * | update | **message id** → 频道 id 形状 → content → 成员表 |
 * | remove | **message id** → 频道 id 形状 → 成员表 |
 *
 * 三条容易踩的细则：
 * 1. 所有失败都是 `BAD_INPUT`（除"查库本身出错"是 `RUNTIME_EXCEPTION`）**并且关闭会话**——
 *    上游 `ProcessRequest` 返回 false，`sessionWS.consume` 跳出读循环；
 * 2. `content` 必须是 **JSON 对象**：`json.Valid` 且 trim 后首字节是 `{`，数组/标量都不行；
 * 3. 频道 id 里带 UUID 时（群组/私聊）大小写在协议上等价，这里统一成规范形再当键用，
 *    否则同一个私聊会因为客户端写法不同落进两个频道 DO。
 *
 * 契约源（机器可读）：
 * 契约源: server/pipeline_channel.go::Pipeline.channelJoin
 * 契约源: server/pipeline_channel.go::Pipeline.channelLeave
 * 契约源: server/pipeline_channel.go::Pipeline.channelMessageSend
 * 契约源: server/pipeline_channel.go::Pipeline.channelMessageUpdate
 * 契约源: server/pipeline_channel.go::Pipeline.channelMessageRemove
 *
 * REQ-0001-010
 */

import { findUsersByIds } from "../domain/identity/store";
import { canAccessGroup } from "../domain/groups/access";
import {
  ChannelJoin_Type,
  Error_Code,
  type ChannelJoin,
  type ChannelLeave,
  type ChannelMessageRemove,
  type ChannelMessageSend,
  type ChannelMessageUpdate,
} from "../proto/realtime_pb";
import type { ChannelOpResult } from "./channel";
import { buildChannelId, channelIdToStream, streamToChannelId, type ChannelStream } from "./channel-ids";
import { errorEnvelope } from "./errors";
import { normalizeMessageId } from "./identifiers";
import type { PipelineContext, PipelineResult } from "./pipeline";

const INVALID_CHANNEL_ID = "Invalid channel identifier";
const INVALID_MESSAGE_ID = "Invalid message identifier";
const INVALID_CONTENT = "Message content must be a valid JSON object";
const INVALID_TARGET = "Invalid channel target";

/** 上游的失败路径：回一条错误帧，然后关连接。 */
function fail(cid: string, code: Error_Code, message: string): PipelineResult {
  return { replies: [errorEnvelope(cid, code, message)], close: true };
}

function codeOf(raw: "BAD_INPUT" | "RUNTIME_EXCEPTION"): Error_Code {
  return raw === "BAD_INPUT" ? Error_Code.BAD_INPUT : Error_Code.RUNTIME_EXCEPTION;
}

/** 服务层的结果 → 管线结果：失败在**这一层**决定"关连接"，服务层不需要知道这个规矩。 */
function outcome(cid: string, result: ChannelOpResult): PipelineResult {
  if (!result.ok) return fail(cid, codeOf(result.code), result.message);
  return { replies: result.replies, close: false };
}

/** 上游：`json.Valid(v) && bytes.TrimSpace(v)[0] == '{'`。数组与标量都不是对象。 */
function isJsonObject(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

/** 频道 id → **规范形**；形状不合法返回 null（调用方回"Invalid channel identifier"）。 */
function canonicalChannelId(raw: string): string | null {
  const stream = channelIdToStream(raw);
  return stream === null ? null : streamToChannelId(stream);
}

interface AccessDenied {
  readonly code: "BAD_INPUT" | "RUNTIME_EXCEPTION";
  readonly message: string;
}

/**
 * 上游 `BuildChannelId` 里"查库"的那一半：私聊要对方存在，群组要调用者是成员。
 * 房间频道任何人可进。
 */
async function checkAccess(
  context: PipelineContext,
  stream: ChannelStream,
): Promise<AccessDenied | null> {
  if (stream.mode === 3) {
    try {
      const allowed = await canAccessGroup(
        context.db,
        context.tenantId,
        stream.subject,
        context.userId,
      );
      if (allowed) return null;
      return { code: "BAD_INPUT", message: `Group not found: ${INVALID_TARGET}` };
    } catch {
      return { code: "RUNTIME_EXCEPTION", message: "Failed to look up group membership" };
    }
  }
  if (stream.mode === 4) {
    // 上游把 (目标用户, 调用者) 排序后当 subject/subcontext，所以"对方"是没被自己占用的那个。
    const peer = stream.subject === context.userId ? stream.subcontext : stream.subject;
    try {
      const users = await findUsersByIds(context.db, context.tenantId, [peer]);
      if (users.length > 0) return null;
      return { code: "BAD_INPUT", message: `User ID not found: ${INVALID_TARGET}` };
    } catch {
      return { code: "RUNTIME_EXCEPTION", message: "Failed to look up user ID" };
    }
  }
  return null;
}

export async function channelJoin(
  context: PipelineContext,
  cid: string,
  incoming: ChannelJoin,
): Promise<PipelineResult> {
  const built = buildChannelId(context.userId, incoming.target, incoming.type);
  if (!built.ok) return fail(cid, Error_Code.BAD_INPUT, built.message);
  const denied = await checkAccess(context, built.stream);
  if (denied !== null) return fail(cid, codeOf(denied.code), denied.message);

  return outcome(
    cid,
    await context.channel.join({
      cid,
      channelId: built.channelId,
      sessionId: context.sessionId,
      userId: context.userId,
      username: context.username,
      // 上游：`Persistence == nil || Persistence.Value`（不给 = 持久化）、
      // `Hidden != nil && Hidden.Value`（不给 = 不隐藏）。
      persistence: incoming.persistence ?? true,
      hidden: incoming.hidden ?? false,
    }),
  );
}

export async function channelLeave(
  context: PipelineContext,
  cid: string,
  incoming: ChannelLeave,
): Promise<PipelineResult> {
  const channelId = canonicalChannelId(incoming.channelId);
  if (channelId === null) return fail(cid, Error_Code.BAD_INPUT, INVALID_CHANNEL_ID);
  return outcome(
    cid,
    await context.channel.leave({
      cid,
      channelId,
      sessionId: context.sessionId,
      userId: context.userId,
      username: context.username,
    }),
  );
}

export async function channelMessageSend(
  context: PipelineContext,
  cid: string,
  incoming: ChannelMessageSend,
): Promise<PipelineResult> {
  const channelId = canonicalChannelId(incoming.channelId);
  if (channelId === null) return fail(cid, Error_Code.BAD_INPUT, INVALID_CHANNEL_ID);
  if (!isJsonObject(incoming.content)) return fail(cid, Error_Code.BAD_INPUT, INVALID_CONTENT);
  return outcome(
    cid,
    await context.channel.send({
      cid,
      channelId,
      sessionId: context.sessionId,
      userId: context.userId,
      username: context.username,
      content: incoming.content,
    }),
  );
}

export async function channelMessageUpdate(
  context: PipelineContext,
  cid: string,
  incoming: ChannelMessageUpdate,
): Promise<PipelineResult> {
  const messageId = normalizeMessageId(incoming.messageId);
  if (messageId === null) return fail(cid, Error_Code.BAD_INPUT, INVALID_MESSAGE_ID);
  const channelId = canonicalChannelId(incoming.channelId);
  if (channelId === null) return fail(cid, Error_Code.BAD_INPUT, INVALID_CHANNEL_ID);
  if (!isJsonObject(incoming.content)) return fail(cid, Error_Code.BAD_INPUT, INVALID_CONTENT);
  return outcome(
    cid,
    await context.channel.update({
      cid,
      channelId,
      sessionId: context.sessionId,
      userId: context.userId,
      username: context.username,
      messageId,
      content: incoming.content,
    }),
  );
}

export async function channelMessageRemove(
  context: PipelineContext,
  cid: string,
  incoming: ChannelMessageRemove,
): Promise<PipelineResult> {
  const messageId = normalizeMessageId(incoming.messageId);
  if (messageId === null) return fail(cid, Error_Code.BAD_INPUT, INVALID_MESSAGE_ID);
  const channelId = canonicalChannelId(incoming.channelId);
  if (channelId === null) return fail(cid, Error_Code.BAD_INPUT, INVALID_CHANNEL_ID);
  return outcome(
    cid,
    await context.channel.remove({
      cid,
      channelId,
      sessionId: context.sessionId,
      userId: context.userId,
      username: context.username,
      messageId,
    }),
  );
}

/** 供测试与调用方引用：`ChannelJoin_Type` 的取值（本模块不解释它，只透传）。 */
export const CHANNEL_TYPES = ChannelJoin_Type;
