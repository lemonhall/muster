/**
 * 通知端点的线格式。
 *
 * 两处与"想当然"不同的地方：
 *   1. `persistent` 在列表里**恒为 true**：上游 `NotificationList` 从库里读出来的每条
 *      通知都硬写 `Persistent: true`（能列出来就说明它落库了），所以它总会出现在 JSON 里；
 *   2. `cacheable_cursor` 是普通 string：上游只在 cacheable（REST 恒 true）时给出，
 *      空列表也给（给定游标则原样回带、否则回零点游标），所以实践中它也在。
 *
 * `content` 是**字符串**不是对象：上游存的是 JSON 文本，客户端自己解。
 *
 * 契约源（机器可读）：
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/notification
 * 契约源: server/core_notification.go::NotificationList
 *
 * REQ-0001-013
 */

import type { NotificationListResult } from "../domain/notifications/service";
import type { NotificationRow } from "../domain/notifications/store";
import { formatTimestamp } from "./identity";

export function notificationBody(row: NotificationRow): Record<string, unknown> {
  return {
    id: row.id,
    subject: row.subject,
    ...(row.content === "" ? {} : { content: row.content }),
    // code 为 0 时省略（内置类别都是负数，所以实践中都在）。
    ...(row.code === 0 ? {} : { code: row.code }),
    ...(row.sender_id === "" ? {} : { sender_id: row.sender_id }),
    create_time: formatTimestamp(row.create_time),
    persistent: true,
  };
}

export function notificationListBody(result: NotificationListResult): Record<string, unknown> {
  return {
    ...(result.notifications.length === 0
      ? {}
      : { notifications: result.notifications.map((row) => notificationBody(row)) }),
    ...(result.cacheableCursor === "" ? {} : { cacheable_cursor: result.cacheableCursor }),
  };
}
