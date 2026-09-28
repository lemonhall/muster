import type { ChannelStream } from "../realtime/channel-ids";
import { formatTimestamp } from "./identity";

/**
 * 频道历史的 JSON 线格式（`api.ChannelMessageList`）。
 *
 * 形状规则与其余 REST 响应一致（protojson + `UseProtoNames`，见 `src/wire/identity.ts`）：
 * 零值省略、消息字段缺席即"没这个值"。频道特有的三条：
 *
 * - `code` / `persistent` 是**包装类型**（`google.protobuf.Int32Value` / `BoolValue`），
 *   只要上游设过就一定会出现在线上，哪怕值是 0 或 false。所以这里永远写 `code` 与
 *   `persistent`，不做"零值省略"——与 `permission_read` 那种裸 int32 的处理**不同**。
 * - 三类频道共用同一个 `ChannelMessage`，靠 `room_name` / `group_id` /
 *   `user_id_one` + `user_id_two` 里**恰好一组**非空来区分（上游 `switch stream.Mode`）。
 * - 三个游标都是普通 string 字段，空串即省略。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_channel.go::ChannelMessagesList
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/channel/{channelId}
 *
 * REQ-0001-010
 */

export interface ChannelMessageRecord {
  readonly messageId: string;
  readonly code: number;
  readonly senderId: string;
  readonly username: string;
  readonly content: string;
  readonly createTimeMs: number;
  readonly updateTimeMs: number;
}

/** 时间戳：毫秒 → RFC3339。上游是微秒级，这里是毫秒级（ECN-0007）。 */
function timestampOf(ms: number): string {
  return formatTimestamp(ms / 1000);
}

function streamFields(stream: ChannelStream): Record<string, unknown> {
  switch (stream.mode) {
    case 3:
      return { group_id: stream.subject };
    case 4:
      return { user_id_one: stream.subject, user_id_two: stream.subcontext };
    default:
      return { room_name: stream.label };
  }
}

export function channelMessageBody(
  channelId: string,
  stream: ChannelStream,
  record: ChannelMessageRecord,
): Record<string, unknown> {
  return {
    channel_id: channelId,
    message_id: record.messageId,
    code: record.code,
    sender_id: record.senderId,
    username: record.username,
    content: record.content,
    create_time: timestampOf(record.createTimeMs),
    update_time: timestampOf(record.updateTimeMs),
    // 能出现在历史里的消息一定是持久化过的（上游这里恒为 true）。
    persistent: true,
    ...streamFields(stream),
  };
}

export function channelMessageListBody(
  channelId: string,
  stream: ChannelStream,
  records: readonly ChannelMessageRecord[],
  cursors: { readonly next: string; readonly prev: string; readonly cacheable: string },
): Record<string, unknown> {
  return {
    ...(records.length === 0
      ? {}
      : { messages: records.map((record) => channelMessageBody(channelId, stream, record)) }),
    ...(cursors.next === "" ? {} : { next_cursor: cursors.next }),
    ...(cursors.prev === "" ? {} : { prev_cursor: cursors.prev }),
    ...(cursors.cacheable === "" ? {} : { cacheable_cursor: cursors.cacheable }),
  };
}
