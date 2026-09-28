import { env } from "cloudflare:test";
import { expect } from "vitest";

import { insertLeaderboard } from "../../src/domain/competitive/leaderboard/store";
import type { LeaderboardRow } from "../../src/domain/competitive/leaderboard/definition";
import { bearer, call } from "./tenants";
import type { SocialAccount, SocialWorld } from "./social-world";

/**
 * 竞技域（排行榜 / 锦标赛）的工装。
 *
 * 上游的 `TestApiLeaderboard` / `TestApiTournamentHaystack` 都用一段 Lua 模块在
 * 运行时里 `leaderboard_create` / `tournament_create` 造榜——那是上游唯一能建榜的
 * 入口。本项目**还没有**排行榜创建面的 REST 端点（见 ECN-0010 偏差 10），所以
 * 工装直接写 `leaderboard` 表：被测的是"有了榜之后的读写语义"，而建榜这件事在
 * 本项目里还没有对外契约，用 HTTP 面造它反而是假装有一条不存在的接口。
 *
 * 文件名不带 `.test.ts`，不会被 vitest 收集。
 */

/** 上游 `newUsers()` 的五个分数：`score` 与 `subScore` 都刻意错开，便于区分排序依据。 */
export const SCORES: readonly number[] = [10, 20, 30, 40, 50];
export const SUBSCORES: readonly number[] = [11, 21, 31, 41, 51];

export interface LeaderboardOverrides {
  readonly sort_order?: number;
  readonly operator?: number;
  readonly enable_ranks?: number;
  readonly duration?: number;
  readonly start_time?: number;
  readonly end_time?: number;
  readonly max_size?: number;
  readonly max_num_score?: number;
  readonly join_required?: number;
  readonly authoritative?: number;
  readonly reset_schedule?: string;
  readonly metadata?: string;
  readonly title?: string;
  readonly category?: number;
  readonly size?: number;
}

/** 排行榜行的默认值：升序 + BEST + 无名次缓存 + 不重置——也就是"最素的榜"。 */
export function leaderboardRow(
  tenantId: string,
  id: string,
  overrides: LeaderboardOverrides = {},
): LeaderboardRow {
  return {
    tenant_id: tenantId,
    id,
    authoritative: overrides.authoritative ?? 0,
    sort_order: overrides.sort_order ?? 0,
    operator: overrides.operator ?? 0,
    reset_schedule: overrides.reset_schedule ?? "",
    metadata: overrides.metadata ?? "",
    create_time: Math.floor(Date.now() / 1000),
    title: overrides.title ?? "",
    description: "",
    category: overrides.category ?? 0,
    start_time: overrides.start_time ?? 0,
    end_time: overrides.end_time ?? 0,
    duration: overrides.duration ?? 0,
    max_size: overrides.max_size ?? 0,
    max_num_score: overrides.max_num_score ?? 0,
    join_required: overrides.join_required ?? 0,
    enable_ranks: overrides.enable_ranks ?? 0,
    size: overrides.size ?? 0,
  };
}

/** 直接种一个排行榜定义，返回它的 id。 */
export async function makeLeaderboard(
  world: SocialWorld,
  overrides: LeaderboardOverrides = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await insertLeaderboard(env.DB, world.tenant, leaderboardRow(world.tenant, id, overrides));
  return id;
}

/** 上游 `TestApiTournamentHaystack` 造的那个锦标赛：两小时档、已开赛、无结束时间。 */
export async function makeTournament(world: SocialWorld, nowSec: number): Promise<string> {
  return makeLeaderboard(world, {
    duration: 7200,
    start_time: nowSec - 3600,
    sort_order: 1,
    operator: 0,
    enable_ranks: 1,
  });
}

/** 线上一条记录的形状（int64 字段是字符串，零值字段整体缺席）。 */
export interface RecordBody {
  readonly leaderboard_id: string;
  readonly owner_id: string;
  readonly score: string;
  readonly subscore: string;
  readonly rank?: string;
  readonly num_score?: number;
  readonly max_num_score?: number;
}

export interface RecordListBody {
  readonly records?: readonly RecordBody[];
  readonly owner_records?: readonly RecordBody[];
  readonly next_cursor?: string;
  readonly prev_cursor?: string;
  readonly rank_count?: string;
}

/** 写一条成绩（`POST /v2/leaderboard/{id}` 与 `POST /v2/tournament/{id}` 同形）。 */
export async function writeScore(
  kind: "leaderboard" | "tournament",
  account: SocialAccount,
  id: string,
  score: number,
  subscore: number,
): Promise<RecordBody> {
  const response = await call(`/v2/${kind}/${id}`, {
    method: "POST",
    authorization: bearer(account.token),
    body: { record: { score, subscore } },
  });
  if (response.status !== 200) {
    throw new Error(`写分失败：${response.status} ${await response.text()}`);
  }
  return (await response.json()) as RecordBody;
}

/** 删掉自己的成绩（`DELETE /v2/{kind}/{id}`），返回 HTTP 状态码。 */
export async function deleteScore(
  kind: "leaderboard" | "tournament",
  account: SocialAccount,
  id: string,
): Promise<number> {
  const response = await call(`/v2/${kind}/${id}`, {
    method: "DELETE",
    authorization: bearer(account.token),
  });
  return response.status;
}

/** 读一页记录；`query` 是已经拼好的 `?k=v` 串（含开头问号）或空串。 */
export async function listRecords(
  kind: "leaderboard" | "tournament",
  account: SocialAccount,
  id: string,
  query = "",
): Promise<RecordListBody> {
  const response = await call(`/v2/${kind}/${id}${query}`, {
    authorization: bearer(account.token),
  });
  if (response.status !== 200) {
    throw new Error(`读列表失败：${response.status} ${await response.text()}`);
  }
  return (await response.json()) as RecordListBody;
}

/** 直接读榜的 `size` 列（入榜人数），用于核对"占位有没有被回滚"。 */
export async function readSize(tenantId: string, id: string): Promise<number> {
  const row = await env.DB.prepare("SELECT size FROM leaderboard WHERE tenant_id = ?1 AND id = ?2")
    .bind(tenantId, id)
    .first<{ size: number }>();
  return row?.size ?? -1;
}

/** 上游 `populateLb`：五个账号依次写 10/20/30/40/50。 */
export async function populate(
  kind: "leaderboard" | "tournament",
  world: SocialWorld,
  id: string,
): Promise<void> {
  for (let index = 0; index < world.accounts.length; index += 1) {
    await writeScore(kind, world.accounts[index] as SocialAccount, id, SCORES[index] as number, SUBSCORES[index] as number);
  }
}

/** `verifyList`：断言列表的顺序、分数名次与 owner id 全部对上。 */
export function expectOrderedRecords(
  body: RecordListBody,
  accounts: readonly SocialAccount[],
  scores: readonly number[],
  subScores: readonly number[],
): void {
  const records = body.records ?? [];
  expect(records).toHaveLength(accounts.length);
  expect(records.map((record) => record.owner_id)).toEqual(accounts.map((account) => account.id));
  expect(records.map((record) => record.score)).toEqual(scores.map((score) => String(score)));
  expect(records.map((record) => record.subscore)).toEqual(subScores.map((score) => String(score)));
  expect(records.map((record) => record.rank)).toEqual(scores.map((_, index) => String(index + 1)));
}
