/**
 * 通知的实时帧：`Envelope.notifications{notifications:[...]}`。
 *
 * 上游在 `NotificationSend` 里对**在线**用户直接投递这个帧；本项目把"在线判断 + 投递"
 * 交给每租户一个的会话注册表 DO（注册表知道谁在线），通知域只负责把这一帧构造出来。
 *
 * 帧里的通知与库里那份**同形**（id / subject / content / code / sender_id / create_time /
 * persistent），这样客户端无论从列表还是从长连接拿到，反序列化出来的对象一致。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_notification.go::NotificationSend
 * 契约源: src/proto/api/api.proto::Notification
 *
 * REQ-0001-013
 */

import { create } from "@bufbuild/protobuf";

import {
  EnvelopeSchema,
  NotificationsSchema,
  type Envelope,
} from "../proto/realtime_pb";
import { NotificationSchema } from "../proto/api/api_pb";

export interface NotificationSnapshot {
  readonly id: string;
  readonly subject: string;
  readonly content: string;
  readonly code: number;
  readonly senderId: string;
  readonly createTime: number;
  readonly persistent: boolean;
}

export function notificationsEnvelope(items: readonly NotificationSnapshot[]): Envelope {
  return create(EnvelopeSchema, {
    message: {
      case: "notifications",
      value: create(NotificationsSchema, {
        notifications: items.map((item) =>
          create(NotificationSchema, {
            id: item.id,
            subject: item.subject,
            content: item.content,
            code: item.code,
            senderId: item.senderId,
            persistent: item.persistent,
            createTime: { seconds: BigInt(item.createTime), nanos: 0 },
          }),
        ),
      }),
    },
  });
}
