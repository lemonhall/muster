/**
 * 排行榜 / 锦标赛的**定义**（上游 `server.Leaderboard` 的字段子集）。
 *
 * 上游把两者合并成一个结构：`Duration != 0` 就是锦标赛，`MaxSize != math.MaxInt32`
 * 就是"有名额上限"。这里保持同样的判别方式，只是把"没有上限"从 `MaxInt32`
 * 换成 `0`（D1 的 INTEGER 存得下 MaxInt32，但 0 是更诚实的哨兵，见 ECN-0010 偏差 4）。
 *
 * 契约源（机器可读）：
 * 契约源: server/leaderboard_cache.go::Leaderboard.IsTournament
 * 契约源: server/leaderboard_cache.go::Leaderboard.HasMaxSize
 */

import { parseCron, type CronExpression } from "../cron/expression";

/** 上游 `api.SortOrder`：0 = ASC（越小越好），1 = DESC（越大越好）。 */
export const SortOrder = { Ascending: 0, Descending: 1 } as const;

/**
 * 榜单**自己**的 operator，也就是 `leaderboard.operator` 这一列的取值。
 *
 * 注意它与 `api.Operator`（写入请求里的 operator override）**不是同一套编号**：
 * 这里 0 就是 BEST；而 proto 的 `api.Operator` 里 0 是 NO_OVERRIDE、BEST 是 1。
 * 上游也是两套（`LeaderboardOperator*` 与 `api.Operator`），靠一张表互相映射；
 * 混用会让 `BEST` 悄悄变成"不覆盖"，所以这里分两个名字，不共用数字常量。
 */
export const LeaderboardOperator = { Best: 0, Set: 1, Increment: 2, Decrement: 3 } as const;

/** `api.Operator`：写入请求里可以覆盖榜单 operator 的那一组取值。 */
export const ApiOperator = {
  NoOverride: 0,
  Best: 1,
  Set: 2,
  Increment: 3,
  Decrement: 4,
} as const;

export interface LeaderboardRow {
  readonly tenant_id: string;
  readonly id: string;
  readonly authoritative: number;
  readonly sort_order: number;
  readonly operator: number;
  readonly reset_schedule: string;
  readonly metadata: string;
  readonly create_time: number;
  readonly title: string;
  readonly description: string;
  readonly category: number;
  readonly start_time: number;
  readonly end_time: number;
  readonly duration: number;
  readonly max_size: number;
  readonly max_num_score: number;
  readonly join_required: number;
  readonly enable_ranks: number;
  readonly size: number;
}

export interface Leaderboard {
  readonly id: string;
  readonly authoritative: boolean;
  readonly sortOrder: number;
  readonly operator: number;
  readonly resetScheduleText: string;
  readonly resetSchedule: CronExpression | null;
  readonly metadata: string;
  readonly createTime: number;
  readonly title: string;
  readonly description: string;
  readonly category: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly duration: number;
  readonly maxSize: number;
  readonly maxNumScore: number;
  readonly joinRequired: boolean;
  readonly enableRanks: boolean;
  readonly size: number;
  readonly isTournament: boolean;
  readonly hasMaxSize: boolean;
}

/**
 * 重置表达式在**入库时**就解析一次：一个坏表达式应该在 `leaderboard_create`
 * 那一刻被拒，而不是等到某次定时器扫到它再抛异常（那时没人看得到）。
 */
export function toLeaderboard(row: LeaderboardRow): Leaderboard {
  const resetSchedule = row.reset_schedule === "" ? null : parseCron(row.reset_schedule);
  return {
    id: row.id,
    authoritative: row.authoritative !== 0,
    sortOrder: row.sort_order,
    operator: row.operator,
    resetScheduleText: row.reset_schedule,
    resetSchedule,
    metadata: row.metadata,
    createTime: row.create_time,
    title: row.title,
    description: row.description,
    category: row.category,
    startTime: row.start_time,
    endTime: row.end_time,
    duration: row.duration,
    maxSize: row.max_size,
    maxNumScore: row.max_num_score,
    joinRequired: row.join_required !== 0,
    enableRanks: row.enable_ranks !== 0,
    size: row.size,
    isTournament: row.duration !== 0,
    hasMaxSize: row.max_size > 0,
  };
}
