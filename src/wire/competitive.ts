/**
 * 排行榜 / 锦标赛端点的线格式（protojson + `UseProtoNames`）。
 *
 * 三条容易写错的规则：
 *   1. `score` / `subscore` / `rank` / `rank_count` 在 proto 里是 **int64**，
 *      protojson 把它们序列化成**字符串**（`"10"` 而不是 `10`）；`num_score` /
 *      `max_num_score` 是 int32/uint32，照旧是数字；
 *   2. 零值整体省略，所以 `rank: "0"` 不会出现（关掉名次之后前端看到的是"没有 rank"，
 *      反序列化后仍然是 0）；
 *   3. `operator` 是**枚举**，protojson 发的是枚举名（`"BEST"`），不是数字；
 *      而请求里两种写法都收（protojson 的解码器同时认名字与数字）。
 *
 * 契约源（机器可读）：
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/leaderboard/{leaderboardId}
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/tournament/{tournamentId}
 *
 * REQ-0001-015, REQ-0001-016
 */

import { invalidArgument } from "../http/errors";
import type { Leaderboard } from "../domain/competitive/leaderboard/definition";
import type { RankedRecord } from "../domain/competitive/leaderboard/record-store";
import type { LeaderboardRecordListResult } from "../domain/competitive/leaderboard/list";
import type { TournamentDeadlines } from "../domain/competitive/tournament/deadlines";
import { formatTimestamp } from "./identity";

/** `leaderboard.operator`（内部 0..3）→ proto 枚举名。 */
const OPERATOR_NAMES: readonly string[] = ["BEST", "SET", "INCREMENT", "DECREMENT"];

/** `api.Operator` 的枚举名 → 数值。与 `domain/.../definition.ts` 的 `ApiOperator` 同源。 */
const OPERATOR_VALUES: Readonly<Record<string, number>> = {
  NO_OVERRIDE: 0,
  BEST: 1,
  SET: 2,
  INCREMENT: 3,
  DECREMENT: 4,
};

/**
 * 解析写入请求里的 `record.operator`。
 *
 * protojson 的解码器对枚举**同时接受**名字与数字，两者之外一律 400：
 * 消息与上游 gateway 的解码错误同形（`invalid value for enum field operator`）。
 */
export function parseOperatorOverride(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 0 && value <= 4) return value;
    throw invalidArgument("invalid value for enum field operator");
  }
  if (typeof value === "string") {
    const named = OPERATOR_VALUES[value];
    if (named !== undefined) return named;
    // protojson 也接受枚举名对应的数字字符串。
    if (/^\d+$/u.test(value)) return parseOperatorOverride(Number(value));
  }
  throw invalidArgument("invalid value for enum field operator");
}

export function operatorName(operator: number): string {
  return OPERATOR_NAMES[operator] ?? "BEST";
}

/** `api.LeaderboardRecord`。 */
export function recordBody(row: RankedRecord): Record<string, unknown> {
  return {
    leaderboard_id: row.leaderboard_id,
    owner_id: row.owner_id,
    ...(row.username === null || row.username === "" ? {} : { username: row.username }),
    score: String(row.score),
    subscore: String(row.subscore),
    ...(row.num_score === 0 ? {} : { num_score: row.num_score }),
    ...(row.metadata === "" || row.metadata === "{}" ? {} : { metadata: row.metadata }),
    create_time: formatTimestamp(row.create_time),
    update_time: formatTimestamp(row.update_time),
    ...(row.expiry_time === 0 ? {} : { expiry_time: formatTimestamp(row.expiry_time) }),
    ...(row.rank === 0 ? {} : { rank: String(row.rank) }),
    ...(row.max_num_score === 0 ? {} : { max_num_score: row.max_num_score }),
  };
}

function recordsField(key: string, rows: readonly RankedRecord[]): Record<string, unknown> {
  return rows.length === 0 ? {} : { [key]: rows.map((row) => recordBody(row)) };
}

/** `api.LeaderboardRecordList` / `api.TournamentRecordList`（两者字段完全一样）。 */
export function recordListBody(result: LeaderboardRecordListResult): Record<string, unknown> {
  return {
    ...recordsField("records", result.records),
    ...recordsField("owner_records", result.ownerRecords),
    ...(result.nextCursor === "" ? {} : { next_cursor: result.nextCursor }),
    ...(result.prevCursor === "" ? {} : { prev_cursor: result.prevCursor }),
    ...(result.rankCount === 0 ? {} : { rank_count: String(result.rankCount) }),
  };
}

/** `api.Leaderboard`：`prev_reset` / `next_reset` 是由重置表达式算出来的值。 */
export function leaderboardBody(
  leaderboard: Leaderboard,
  prevReset: number,
  nextReset: number,
): Record<string, unknown> {
  return {
    id: leaderboard.id,
    ...(leaderboard.sortOrder === 0 ? {} : { sort_order: leaderboard.sortOrder }),
    operator: operatorName(leaderboard.operator),
    ...(prevReset === 0 ? {} : { prev_reset: prevReset }),
    ...(nextReset === 0 ? {} : { next_reset: nextReset }),
    ...(leaderboard.metadata === "" || leaderboard.metadata === "{}"
      ? {}
      : { metadata: leaderboard.metadata }),
    create_time: formatTimestamp(leaderboard.createTime),
    ...(leaderboard.authoritative ? { authoritative: true } : {}),
  };
}

export interface TournamentBodyInput {
  readonly leaderboard: Leaderboard;
  readonly deadlines: TournamentDeadlines;
  readonly size: number;
  readonly prevReset: number;
  readonly canEnter: boolean;
}

/** `api.Tournament`。 */
export function tournamentBody(input: TournamentBodyInput): Record<string, unknown> {
  const board = input.leaderboard;
  return {
    id: board.id,
    ...(board.title === "" ? {} : { title: board.title }),
    ...(board.description === "" ? {} : { description: board.description }),
    ...(board.category === 0 ? {} : { category: board.category }),
    ...(board.sortOrder === 0 ? {} : { sort_order: board.sortOrder }),
    ...(input.size === 0 ? {} : { size: input.size }),
    ...(board.maxSize === 0 ? {} : { max_size: board.maxSize }),
    ...(board.maxNumScore === 0 ? {} : { max_num_score: board.maxNumScore }),
    ...(input.canEnter ? { can_enter: true } : {}),
    ...(input.deadlines.endActive === 0 ? {} : { end_active: input.deadlines.endActive }),
    ...(input.deadlines.expiry === 0 ? {} : { next_reset: input.deadlines.expiry }),
    ...(board.metadata === "" || board.metadata === "{}" ? {} : { metadata: board.metadata }),
    create_time: formatTimestamp(board.createTime),
    ...(board.startTime === 0 ? {} : { start_time: formatTimestamp(board.startTime) }),
    ...(board.endTime === 0 ? {} : { end_time: formatTimestamp(board.endTime) }),
    ...(board.duration === 0 ? {} : { duration: board.duration }),
    ...(input.deadlines.startActive === 0 ? {} : { start_active: input.deadlines.startActive }),
    ...(input.prevReset === 0 ? {} : { prev_reset: input.prevReset }),
    operator: operatorName(board.operator),
    ...(board.authoritative ? { authoritative: true } : {}),
    ...(board.joinRequired ? { join_required: true } : {}),
  };
}

export function tournamentListBody(
  tournaments: readonly Record<string, unknown>[],
  cursor: string,
): Record<string, unknown> {
  return {
    ...(tournaments.length === 0 ? {} : { tournaments }),
    ...(cursor === "" ? {} : { cursor }),
  };
}
