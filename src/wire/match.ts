/**
 * 对局列表与匹配器统计的线格式（protojson + `UseProtoNames`）。
 *
 * 四条容易写错的规则：
 *
 * 1. `label` 在 proto 里是 `google.protobuf.StringValue`：**权威对局一定带它**
 *    （上游赋的是 `&wrapperspb.StringValue{Value: l}`，空串也带），中继对局不带
 *    （上游传的 `label` 是 nil）。区别在 JSON 里看得见：一个是有键、一个是没键；
 * 2. 零值整体省略：中继对局的 `authoritative: false`、`size: 0`、空池的
 *    `ticket_count: 0` 都不会出现在响应里——客户端反序列化之后仍然是同一个值；
 * 3. **空列表整个 `matches` 键省略**（protojson 对 repeated 字段的规矩），
 *    不是 `"matches": []`；
 * 4. 时间戳是 RFC3339（`2026-09-29T03:24:55Z`），且**秒精度**——本项目的匹配器
 *    内部记的是毫秒，在这一层才换成秒。
 *
 * 与上游的一处已知差异：上游的权威对局条目还会带 `tick_rate` 与 `handler_name`
 * （它们是运行时 handler 的属性）。本项目还没有运行时（M8），权威对局的 tick rate
 * 恒为 0、handler 名恒为空——按规则 2 它们本来就不该出现在 JSON 里，所以形状一致，
 * 记在 ECN-0011 偏差 9。
 *
 * 契约源（机器可读）：
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/match
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/matchmaker/stats
 *
 * REQ-0001-018
 */

import type { MatchRecord } from "../domain/match/catalog";
import type { MatchmakerStatsDto } from "../durable/matchmaker-call";
import { formatTimestamp } from "./identity";

/** `api.Match`。 */
export function matchBody(record: MatchRecord): Record<string, unknown> {
  return {
    match_id: record.matchId,
    // 中继对局是 `false`（零值省略）；权威对局是 `true`。
    ...(record.authoritative ? { authoritative: true } : {}),
    // 权威对局一定带 label（空串也带）；中继对局没有这个字段。
    ...(record.authoritative ? { label: record.label } : {}),
    ...(record.size === 0 ? {} : { size: record.size }),
  };
}

/** `api.MatchList`。空列表时整条 `matches` 键省略。 */
export function matchListBody(matches: readonly MatchRecord[]): Record<string, unknown> {
  if (matches.length === 0) return {};
  return { matches: matches.map((record) => matchBody(record)) };
}

/** `api.MatchmakerCompletionStats`：毫秒 → 秒 → RFC3339。 */
function completionBody(completion: { createdAt: number; completedAt: number }): Record<string, unknown> {
  return {
    create_time: formatTimestamp(Math.floor(completion.createdAt / 1000)),
    complete_time: formatTimestamp(Math.floor(completion.completedAt / 1000)),
  };
}

/** `api.MatchmakerStats`。 */
export function matchmakerStatsBody(stats: MatchmakerStatsDto): Record<string, unknown> {
  return {
    ...(stats.ticketCount === 0 ? {} : { ticket_count: stats.ticketCount }),
    ...(stats.oldestTicketCreateTime === null
      ? {}
      : { oldest_ticket_create_time: formatTimestamp(Math.floor(stats.oldestTicketCreateTime / 1000)) }),
    ...(stats.completions.length === 0
      ? {}
      : { completions: stats.completions.map(completionBody) }),
  };
}
