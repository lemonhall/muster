/**
 * 锦标赛的当期窗口：`calculateTournamentDeadlines` 的逐行搬运。
 *
 * 上游 `server/core_tournament.go` 里这个函数是**纯计算**（不碰库、不看时钟，
 * 时间由调用方传入），而 `core_tournament_test.go` 的 4 条用例就是逐字钉它的返回值。
 * 所以这里把它原样搬过来，一行逻辑都不省：任何一个 `if` 换了位置，
 * 那 4 条用例里至少一条会红。
 *
 * 三个返回值：
 *   - `startActive`：这一期从哪一秒开始可以写分；
 *   - `endActive`：这一期从哪一秒开始不能再写分（`<= now` 即"已结束"）；
 *   - `expiry`：这一期的记录从哪一秒开始作废（下一期开始，或锦标赛的 `end_time`）。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_tournament.go::calculateTournamentDeadlines
 */

import type { CronExpression } from "../cron/expression";

export interface TournamentDeadlines {
  readonly startActive: number;
  readonly endActive: number;
  readonly expiry: number;
}

const SECOND_MS = 1000;

export function calculateTournamentDeadlines(
  startTime: number,
  endTime: number,
  duration: number,
  resetSchedule: CronExpression | null,
  now: Date,
): TournamentDeadlines {
  const nowUnix = Math.floor(now.getTime() / SECOND_MS);

  if (resetSchedule !== null) {
    let startActive: number;

    if (nowUnix < startTime) {
      // 传进来的时刻还没到开赛时间：真正开赛是 startTime 之后的第一个重置点。
      startActive = Math.floor(resetSchedule.next(new Date(startTime * SECOND_MS)).getTime() / SECOND_MS);
    } else {
      // 判断是不是正好落在重置点上：`Next(t-1s) == t` 只在"严格晚于"语义下成立。
      const landsOnSchedule =
        Math.floor(resetSchedule.next(new Date(now.getTime() - SECOND_MS)).getTime() / SECOND_MS) === nowUnix;
      startActive = landsOnSchedule
        ? nowUnix
        : Math.floor(resetSchedule.last(now).getTime() / SECOND_MS);
    }

    let endActive = startActive + duration;
    let expiry = Math.floor(
      resetSchedule.next(new Date(startActive * SECOND_MS)).getTime() / SECOND_MS,
    );

    if (endActive > expiry) endActive = expiry;

    if (startTime > endActive) {
      // 开赛时间落在"当期已结束、下一期还没开始"的缝里。
      const schedules = resetSchedule
        .nextN(new Date(startTime * SECOND_MS), 2)
        .map((value) => Math.floor(value.getTime() / SECOND_MS));
      startActive = schedules[0] as number;
      endActive = startActive + duration;
      expiry = schedules[1] as number;
      if (endActive > expiry) endActive = expiry;
    } else if (startTime > startActive) {
      startActive = startTime;
    }

    if (endTime > 0 && expiry > endTime) {
      expiry = endTime;
      if (endActive > expiry) endActive = expiry;
    }

    return { startActive, endActive, expiry };
  }

  let endActive = startTime + duration;
  const expiry = endTime;
  if (endTime > 0 && endActive > endTime) endActive = endTime;
  return { startActive: startTime, endActive, expiry };
}

/**
 * "这一期还有没有记录可看"：`calculateExpiryOverride` 的上半段。
 *
 * 上游在 `overrideExpiry == 0` 时按排行榜类型算当期 expiry；小于等于当前时刻就
 * 认定"这一期已经过去"，列表直接回空而不是回上一期的数据。
 */
export function resolveExpiry(
  overrideExpiry: number,
  definition: {
    readonly isTournament: boolean;
    readonly startTime: number;
    readonly endTime: number;
    readonly duration: number;
    readonly resetSchedule: CronExpression | null;
  },
  now: Date,
): { readonly expiry: number; readonly recordsPossible: boolean } {
  if (overrideExpiry !== 0) {
    return { expiry: overrideExpiry, recordsPossible: overrideExpiry > Math.floor(now.getTime() / 1000) };
  }
  if (definition.isTournament) {
    const { expiry } = calculateTournamentDeadlines(
      definition.startTime,
      definition.endTime,
      definition.duration,
      definition.resetSchedule,
      now,
    );
    const nowUnix = Math.floor(now.getTime() / 1000);
    return { expiry, recordsPossible: !(expiry !== 0 && expiry <= nowUnix) };
  }
  if (definition.resetSchedule !== null) {
    return {
      expiry: Math.floor(definition.resetSchedule.next(now).getTime() / 1000),
      recordsPossible: true,
    };
  }
  return { expiry: 0, recordsPossible: true };
}
