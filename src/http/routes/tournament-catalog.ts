/**
 * 锦标赛目录（`GET /v2/tournament`）的查询参数校验与"能不能进"的计算。
 *
 * 四个参数的默认值与边界文案都是上游 `ApiServer.ListTournaments` 逐行定的：
 *
 * | 参数 | 默认 | 边界 |
 * |---|---|---|
 * | `category_start` | 0 | 无 |
 * | `category_end` | 127 | `>= 128` → `Tournament category end must be >=0 and <128.`；`< start` → `...greater than category start.` |
 * | `start_time` | -1（不参与过滤） | 无 |
 * | `end_time` | -1（只看未结束的） | 非 0 且 `< start_time` → `Tournament end time must be greater than start time.` |
 * | `limit` | 100 | `<1 或 >100` → `Limit must be between 1 and 100.` |
 *
 * `can_enter` 是**算出来的**（不落库）：未开赛、已过 `end_active`、或名额已满
 * 都是 `false`。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_tournament.go::ListTournaments
 */

import { queryOptionalInt, queryValue } from "../body";
import { invalidArgument } from "../errors";
import type { UserContext } from "../router";
import type { Leaderboard } from "../../domain/competitive/leaderboard/definition";
import { calculateTournamentDeadlines } from "../../domain/competitive/tournament/deadlines";
import type { TournamentListFilters } from "../../domain/competitive/tournament/catalog";
import type { TournamentBodyInput } from "../../wire/competitive";

const CATEGORY_END_RANGE = "Tournament category end must be >=0 and <128.";
const CATEGORY_END_ORDER = "Tournament category end must be greater than category start.";
const END_TIME_ORDER = "Tournament end time must be greater than start time.";
const LIMIT_RANGE = "Limit must be between 1 and 100.";

export function catalogFilters(context: UserContext): TournamentListFilters {
  const url = context.url;
  const categoryStart = queryOptionalInt(url, "categoryStart", CATEGORY_END_RANGE) ?? 0;
  const rawCategoryEnd = queryOptionalInt(url, "categoryEnd", CATEGORY_END_RANGE);
  const categoryEnd = rawCategoryEnd ?? 127;
  if (rawCategoryEnd !== undefined) {
    if (categoryEnd >= 128) throw invalidArgument(CATEGORY_END_RANGE);
    if (categoryEnd < categoryStart) throw invalidArgument(CATEGORY_END_ORDER);
  }
  const startTime = queryOptionalInt(url, "startTime", END_TIME_ORDER) ?? -1;
  const rawEndTime = queryOptionalInt(url, "endTime", END_TIME_ORDER);
  const endTime = rawEndTime ?? -1;
  if (rawEndTime !== undefined && endTime !== 0 && endTime < startTime) {
    throw invalidArgument(END_TIME_ORDER);
  }
  const limit = queryOptionalInt(url, "limit", LIMIT_RANGE) ?? 100;
  if (limit < 1 || limit > 100) throw invalidArgument(LIMIT_RANGE);
  return { categoryStart, categoryEnd, startTime, endTime, limit, cursor: queryValue(url, "cursor") };
}

/** `can_enter` 与 `start_active` / `end_active` / `next_reset` 是同一次计算出来的。 */
export function catalogCanEnter(leaderboard: Leaderboard, now: Date): TournamentBodyInput {
  const deadlines = calculateTournamentDeadlines(
    leaderboard.startTime,
    leaderboard.endTime,
    leaderboard.duration,
    leaderboard.resetSchedule,
    now,
  );
  const nowSec = Math.floor(now.getTime() / 1000);
  let canEnter = deadlines.startActive <= nowSec && deadlines.endActive >= nowSec;
  if (canEnter && leaderboard.hasMaxSize && leaderboard.size >= leaderboard.maxSize) canEnter = false;
  const prevReset =
    leaderboard.resetSchedule !== null && leaderboard.startTime <= nowSec
      ? Math.floor(leaderboard.resetSchedule.last(now).getTime() / 1000)
      : 0;
  return { leaderboard, deadlines, size: leaderboard.size, prevReset, canEnter };
}
