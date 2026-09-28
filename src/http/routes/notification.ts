/**
 * 通知的两条端点。
 *
 * 两条都**只在 query 里**取值（照 swagger：`GET` 的 `limit` / `cacheableCursor`，
 * `DELETE` 的 `ids`），没有 JSON body。
 *
 * `cacheableCursor` 这个名字是 grpc-gateway 按 proto 字段的 JSON 名生成的
 * （proto 字段叫 `cacheable_cursor`）。两种写法都收：官方 SDK 用驼峰，
 * 手写脚本常常用下划线，而两者在协议上指向同一个字段。
 *
 * 契约源（机器可读）：
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/notification
 * 契约源: server/api_notification.go::ListNotifications
 * 契约源: server/api_notification.go::DeleteNotifications
 *
 * REQ-0001-013
 */

import { json, queryList, queryOptionalInt, queryValue } from "../body";
import type { Router } from "../router";
import { deleteNotificationsFor, listNotificationsFor } from "../../domain/notifications/service";
import { notificationListBody } from "../../wire/notification";

const LIMIT_ERROR = "Invalid limit - limit must be between 1 and 100.";

export function registerNotificationRoutes(router: Router): void {
  router.handleUser("GET", "/v2/notification", async (context) => {
    const limit = queryOptionalInt(context.url, "limit", LIMIT_ERROR);
    const result = await listNotificationsFor(
      context.env.DB,
      context.tenantEnv.tenantId,
      context.session.user.id,
      {
        ...(limit === undefined ? {} : { limit }),
        cursor: queryValue(context.url, "cacheableCursor", "cacheable_cursor"),
      },
    );
    return json(notificationListBody(result));
  });

  router.handleUser("DELETE", "/v2/notification", async (context) => {
    // 空 `ids` 是成功的空操作（上游 `len(in.GetIds()) == 0` 的早退）。
    const ids = queryList(context.url, "ids");
    if (ids.length === 0) return json({});
    await deleteNotificationsFor(
      context.env.DB,
      context.tenantEnv.tenantId,
      context.session.user.id,
      ids,
    );
    return json({});
  });
}
