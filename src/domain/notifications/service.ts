/**
 * 通知领域层：列表、删除、以及"发出通知"。
 *
 * 三条容易踩的细则（都来自上游 `core_notification.go`）：
 *   1. `ListNotifications` 的默认 limit 是 **1**——不传就只回一条。这不是笔误，
 *      是上游 api 层的默认值，客户端 SDK 的"拉取未读"轮询正靠它；
 *   2. 列表永远带 `cacheable_cursor`，**空列表也给**（上游 `cacheable=true` 分支）；
 *   3. 删除只删得掉**自己的**通知：`WHERE user_id = $1`，别人的 id 传进来是无声的 0 行。
 *
 * 投递（用户在线时同时推一条 WS 帧）在这里做：先落库再推送。顺序是刻意的——
 * 推送失败不能让通知丢失，库里那份才是权威（客户端下次列表就能补上）。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_notification.go::ListNotifications
 * 契约源: server/api_notification.go::DeleteNotifications
 * 契约源: server/core_notification.go::NotificationSend
 *
 * REQ-0001-013
 */

import { invalidArgument } from "../../http/errors";
import type { Bindings } from "../../env";
import { registryNotify } from "../../durable/registry-call";
import type { NotificationSnapshot } from "../../realtime/notifications";
import { decodeNotificationCursor, encodeNotificationCursor } from "./cursor";
import {
  deleteNotifications,
  insertNotifications,
  listNotifications,
  type NewNotification,
  type NotificationRow,
} from "./store";

/** 上游 `api_notification.go` 的默认值：`limit := 1`。 */
export const DEFAULT_NOTIFICATION_LIMIT = 1;
export const MAX_NOTIFICATION_LIMIT = 100;

export interface NotificationListResult {
  readonly notifications: readonly NotificationRow[];
  readonly cacheableCursor: string;
}

export interface ListNotificationsInput {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export async function listNotificationsFor(
  db: D1Database,
  tenantId: string,
  userId: string,
  input: ListNotificationsInput,
): Promise<NotificationListResult> {
  const limit = input.limit ?? DEFAULT_NOTIFICATION_LIMIT;
  if (limit < 1 || limit > MAX_NOTIFICATION_LIMIT) {
    throw invalidArgument("Invalid limit - limit must be between 1 and 100.");
  }

  const rawCursor = input.cursor ?? "";
  const cursor = rawCursor === "" ? null : decodeNotificationCursor(rawCursor);
  const rows = await listNotifications(db, tenantId, userId, limit, cursor);
  const page = rows.length > limit ? rows.slice(0, limit) : rows;

  // 上游：空结果 + cacheable 时，若调用方带了游标就原样回带，否则回"零点游标"。
  // 这里把两种情况都表达成"能继续从同一位置往前看"，客户端拿到的是一个稳定值。
  if (page.length === 0) {
    return { notifications: [], cacheableCursor: rawCursor === "" ? encodeNotificationCursor(null) : rawCursor };
  }

  const last = page[page.length - 1] as NotificationRow;
  return { notifications: page, cacheableCursor: encodeNotificationCursor({ createTime: last.create_time, id: last.id }) };
}

export async function deleteNotificationsFor(
  db: D1Database,
  tenantId: string,
  userId: string,
  ids: readonly string[],
): Promise<void> {
  await deleteNotifications(db, tenantId, userId, ids);
}

export interface SendNotificationInput {
  readonly userId: string;
  readonly subject: string;
  readonly content: string;
  readonly code: number;
  readonly senderId: string;
}

/**
 * 落库 + 尽力推送。
 *
 * id 与 create_time 在这里生成（上游在调用点生成），保证"同一次发送的多条通知
 * 时间一致、id 各不相同"。
 */
export async function sendNotifications(
  env: Bindings,
  tenantId: string,
  now: number,
  notifications: readonly SendNotificationInput[],
): Promise<void> {
  if (notifications.length === 0) return;
  const rows: NewNotification[] = notifications.map((notification) => ({
    id: crypto.randomUUID(),
    userId: notification.userId,
    subject: notification.subject,
    content: notification.content,
    code: notification.code,
    senderId: notification.senderId,
    createTime: now,
  }));
  await insertNotifications(env.DB, tenantId, rows);

  // 推送用的对象与库里那份同形。`persistent` 恒为 true：这里发的通知**已经落库**，
  // 而落库正是"持久化"的定义（上游在 `NotificationSend` 里按同一个标志筛选）。
  const byUser = new Map<string, NotificationSnapshot[]>();
  for (const row of rows) {
    const snapshot: NotificationSnapshot = {
      id: row.id,
      subject: row.subject,
      content: row.content,
      code: row.code,
      senderId: row.senderId,
      createTime: row.createTime,
      persistent: true,
    };
    const bucket = byUser.get(row.userId);
    if (bucket === undefined) byUser.set(row.userId, [snapshot]);
    else bucket.push(snapshot);
  }
  // 推送是尽力而为：接收者可能根本没连上来。失败只落日志，不影响已落库的事实。
  await Promise.allSettled(
    [...byUser.entries()].map(([userId, userRows]) => registryNotify(env, tenantId, userId, userRows)),
  );
}
