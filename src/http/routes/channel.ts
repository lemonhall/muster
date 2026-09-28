import { json, queryValue } from "../body";
import { invalidArgument } from "../errors";
import type { Router } from "../router";
import { channelPage, type ChannelPageDenial } from "../../durable/channel-call";
import { channelIdToStream } from "../../realtime/channel-ids";

/**
 * 频道历史的 REST 端点：`GET /v2/channel/{channelId}`。
 *
 * 校验顺序**逐字照抄**上游 `ApiServer.ListChannelMessages`（顺序是可观测契约）：
 *
 * 1. 缺 channel_id → `Invalid channel ID.`
 * 2. limit 给了就必须在 1..100 → `Invalid limit - limit must be between 1 and 100.`
 * 3. forward 缺省 true
 * 4. 频道 id 解不出来 → `Invalid channel ID.`
 * 5. 游标 / 准入 / 查询（在频道 DO 里，顺序见 `channel-access.ts`）
 *
 * 三点与上游的取舍写在实现旁边，不藏在文档里：limit 的解析沿用本项目存储端点的
 * 做法（非整数即非法）；`forward` 只认 `false` 这个字面量；DO 的三种拒绝理由
 * 映射成上游的三句话。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_channel.go::ListChannelMessages
 * 契约源: server/core_channel.go::ChannelMessagesList
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/channel/{channelId}
 *
 * REQ-0001-010
 */

const INVALID_CHANNEL_ID = "Invalid channel ID.";
const INVALID_LIMIT = "Invalid limit - limit must be between 1 and 100.";

const DENIAL_MESSAGES: Readonly<Record<ChannelPageDenial, string>> = {
  cursor: "Cursor is invalid or expired.",
  group: "Group not found.",
  channel: "Channel not found.",
};

/** `limit`：缺省 **1**（不是 100）；给了就必须是 1..100 的整数。 */
function limitOf(url: URL): number {
  const raw = queryValue(url, "limit");
  if (raw === "") return 1;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw invalidArgument(INVALID_LIMIT);
  return parsed;
}

/** `forward`：protojson 的 `BoolValue`，缺省 true。只有字面量 `false` 表示倒序。 */
function forwardOf(url: URL): boolean {
  return queryValue(url, "forward") !== "false";
}

export function registerChannelRoutes(router: Router): void {
  router.handleUser("GET", "/v2/channel/{channelId}", async (context) => {
    const raw = context.params["channelId"] ?? "";
    if (raw === "") throw invalidArgument(INVALID_CHANNEL_ID);
    const limit = limitOf(context.url);
    const forward = forwardOf(context.url);
    const stream = channelIdToStream(raw);
    if (stream === null) throw invalidArgument(INVALID_CHANNEL_ID);

    const result = await channelPage(context.env, context.tenantEnv.tenantId, raw, {
      limit,
      forward,
      cursor: queryValue(context.url, "cursor"),
      callerId: context.session.user.id,
    });
    if (!result.ok) throw invalidArgument(DENIAL_MESSAGES[result.reason]);
    return json(result.body);
  });
}
