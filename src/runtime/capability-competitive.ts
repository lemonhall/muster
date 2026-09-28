/**
 * `nk` 的竞技创建面：`leaderboardCreate` / `tournamentCreate`。
 *
 * 上游**只有**这两个入口能把一张榜建出来（客户端 API 里没有"创建排行榜"这条路），
 * 所以它们是 v2 的 ECN-0010 偏差 10 欠下的那一半；偏差 10 的另一半（权威写分）在
 * `capability-records.ts`。本文件的 `buildNkCompetitive` 只装这两条。
 *
 * 两条都是**幂等**的（上游注释原文 "Creation is an idempotent operation."）：已存在
 * 就什么都不做、**连配置都不更新**。唯一的例外是"拿普通榜的 id 建锦标赛"——那是配置
 * 冲突，不是重复创建。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.leaderboardCreate
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.tournamentCreate
 * 契约源: server/leaderboard_cache.go::LocalLeaderboardCache.Create
 * 契约源: server/leaderboard_cache.go::LocalLeaderboardCache.CreateTournament
 *
 * REQ-0001-015
 */

import type { DataContext } from "./capability-data";
import {
  intOf,
  metadataText,
  operatorOf,
  optionalBool,
  optionalInt,
  optionalText,
  resetScheduleOf,
  sortOrderOf,
  text,
} from "./competitive-args";
import { parseCron, type CronExpression } from "../domain/competitive/cron/expression";
import { LeaderboardOperator, SortOrder, type LeaderboardRow } from "../domain/competitive/leaderboard/definition";
import { findLeaderboard, insertLeaderboard } from "../domain/competitive/leaderboard/store";

/** 一行"最素的"排行榜定义：只把调用方给了的字段填上，其余留空。 */
function rowOf(
  tenantId: string,
  id: string,
  fields: Partial<LeaderboardRow> & Pick<LeaderboardRow, "create_time">,
): LeaderboardRow {
  return {
    tenant_id: tenantId,
    id,
    authoritative: 0,
    sort_order: SortOrder.Descending,
    operator: LeaderboardOperator.Best,
    reset_schedule: "",
    metadata: "{}",
    title: "",
    description: "",
    category: 0,
    start_time: 0,
    end_time: 0,
    duration: 0,
    max_size: 0,
    max_num_score: 0,
    join_required: 0,
    enable_ranks: 0,
    size: 0,
    ...fields,
  };
}

export async function createLeaderboard(data: DataContext, args: readonly unknown[]): Promise<void> {
  const id = text(args[0]);
  if (id === "") throw new TypeError("expects a leaderboard ID string");
  const authoritative = optionalBool(args[1], false);
  const sortOrder = sortOrderOf(args[2] === undefined ? "desc" : args[2]);
  const operator = operatorOf(args[3] === undefined ? "best" : args[3]);
  const resetSchedule = resetScheduleOf(args[4]);
  const metadata = metadataText(args[5]);
  const enableRanks = optionalBool(args[6], false);

  if ((await findLeaderboard(data.env.DB, data.tenantId, id)) !== null) return;
  await insertLeaderboard(
    data.env.DB,
    data.tenantId,
    rowOf(data.tenantId, id, {
      create_time: Math.floor(Date.now() / 1000),
      authoritative: authoritative ? 1 : 0,
      sort_order: sortOrder,
      operator,
      reset_schedule: resetSchedule,
      metadata,
      enable_ranks: enableRanks ? 1 : 0,
    }),
  );
}

/**
 * 上游 `checkTournamentConfig` 里唯一一条**运行时 JS 层没做**的校验：给了结束时间时，
 * 它必须**严格晚于**第一次重置时刻。否则这个锦标赛在第一次重置的同一秒就结束——
 * "开了但永远没有一期"是配置错误，不是运行时故障，所以在创建那一刻就得报。
 */
function checkEndTimeAgainstReset(
  cron: CronExpression | null,
  startTime: number,
  endTime: number,
): void {
  if (cron === null || endTime <= 0) return;
  const firstReset = Math.floor(cron.nextN(new Date(startTime * 1000), 1)[0]!.getTime() / 1000);
  if (endTime <= firstReset) {
    throw new Error(
      "error creating tournament: tournament end time cannot be before first reset schedule - " +
        "either increase end time or change/disable reset schedule",
    );
  }
}

export async function createTournament(data: DataContext, args: readonly unknown[]): Promise<void> {
  const id = text(args[0]);
  if (id === "") throw new TypeError("expects a tournament ID string");
  const authoritative = optionalBool(args[1], true);
  const sortOrder = sortOrderOf(args[2] === undefined ? "desc" : args[2]);
  const operator = operatorOf(args[3] === undefined ? "best" : args[3]);

  const duration = intOf(args[4], 0);
  if (duration <= 0) throw new TypeError("duration must be > 0");
  const resetSchedule = resetScheduleOf(args[5]);
  const metadata = metadataText(args[6]);
  const title = optionalText(args[7]);
  const description = optionalText(args[8]);

  const category = optionalInt(args[9], 0);
  if (category < 0 || category >= 128) throw new TypeError("category must be 0-127");
  const startTime = optionalInt(args[10], 0);
  if (startTime < 0) throw new TypeError("startTime must be >= 0.");
  const endTime = optionalInt(args[11], 0);
  if (endTime !== 0 && endTime <= startTime) {
    throw new TypeError(
      "endTime must be > startTime. Use 0 to indicate a tournament that never ends.",
    );
  }
  const maxSize = optionalInt(args[12], 0);
  if (maxSize < 0) throw new TypeError("maxSize must be >= 0");
  const maxNumScore = optionalInt(args[13], 0);
  if (maxNumScore < 0) throw new TypeError("maxNumScore must be >= 0");
  const joinRequired = optionalBool(args[14], false);
  const enableRanks = optionalBool(args[15], false);

  checkEndTimeAgainstReset(resetSchedule === "" ? null : parseCron(resetSchedule), startTime, endTime);

  const existing = await findLeaderboard(data.env.DB, data.tenantId, id);
  if (existing !== null) {
    // 幂等只对"已经是锦标赛"的那张榜成立。
    if (existing.duration !== 0) return;
    throw new Error(
      "error creating tournament: cannot create tournament as leaderboard is already in use",
    );
  }

  await insertLeaderboard(
    data.env.DB,
    data.tenantId,
    rowOf(data.tenantId, id, {
      create_time: Math.floor(Date.now() / 1000),
      authoritative: authoritative ? 1 : 0,
      sort_order: sortOrder,
      operator,
      reset_schedule: resetSchedule,
      metadata,
      title,
      description,
      category,
      start_time: startTime,
      end_time: endTime,
      duration,
      max_size: maxSize,
      max_num_score: maxNumScore,
      join_required: joinRequired ? 1 : 0,
      enable_ranks: enableRanks ? 1 : 0,
    }),
  );
}

export function buildNkCompetitive(data: DataContext): Record<string, unknown> {
  return {
    leaderboardCreate: (...args: unknown[]) => createLeaderboard(data, args),
    tournamentCreate: (...args: unknown[]) => createTournament(data, args),
  };
}
