import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { callTenantRpc, resetRuntimeCache } from "../../../src/runtime/service";
import { callerOf, deployModules, payloadOf, runtimeWorld, type RuntimeWorld } from "./harness";

/**
 * M9 运行时面：`nk.leaderboardCreate` / `nk.tournamentCreate`（DoD 7 的前半）。
 *
 * 反作弊点是**读库里的行**：断言 `leaderboard` 表里那张榜的列真的写成了调用方给的配置，
 * 而不是只看 `nk.*` 有没有抛异常（上游那一组用例就是只看不抛）。
 *
 * 另一条被钉住的是**幂等**：上游注释写着 "Creation is an idempotent operation."，
 * 第二次调用连配置都不更新。只测"第二次没报错"等于没测。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.leaderboardCreate
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.tournamentCreate
 *
 * REQ-0001-015
 */

const MODULE = `
export function InitModule(ctx, logger, nk, initializer) {
  initializer.registerRpc("lb-create", async (call, logger, nk) => {
    await nk.leaderboardCreate("daily-wins", true, "asc", "incr", "0 0 * * *", { level: 3 }, true);
    return "ok";
  });

  initializer.registerRpc("lb-create-again", async (call, logger, nk) => {
    // 同名第二次建：上游是幂等的，配置**不更新**。
    await nk.leaderboardCreate("daily-wins", false, "desc", "set", null, null, false);
    return "ok";
  });

  initializer.registerRpc("tournament-create", async (call, logger, nk) => {
    await nk.tournamentCreate(
      "weekly-cup", true, "desc", "best", 7200, "", { theme: "spring" },
      "Weekly Cup", "Weekly tournament", 7, 0, 0, 0, 3, false, true,
    );
    return "ok";
  });

  initializer.registerRpc("tournament-on-leaderboard", async (call, logger, nk) => {
    await nk.tournamentCreate("daily-wins", true, "desc", "best", 7200);
    return "ok";
  });

  initializer.registerRpc("validation", async (call, logger, nk, which) => {
    if (which === "no-id") await nk.leaderboardCreate("");
    if (which === "bad-sort") await nk.leaderboardCreate("x", false, "sideways");
    if (which === "bad-operator") await nk.leaderboardCreate("x", false, "desc", "median");
    if (which === "bad-bool") await nk.leaderboardCreate("x", 1);
    if (which === "bad-cron") await nk.leaderboardCreate("x", false, "desc", "best", "not a cron");
    if (which === "duration") await nk.tournamentCreate("t", true, "desc", "best", 0);
    if (which === "category") await nk.tournamentCreate("t", true, "desc", "best", 60, "", {}, "", "", 128);
    if (which === "end-before-start") await nk.tournamentCreate("t", true, "desc", "best", 60, "", {}, "", "", 0, 100, 50);
    if (which === "end-before-reset") {
      await nk.tournamentCreate("t", true, "desc", "best", 60, "0 0 1 1 *", {}, "", "", 0, 0, 1000);
    }
    return "ok";
  });
}
`;

interface LeaderboardDbRow {
  readonly authoritative: number;
  readonly sort_order: number;
  readonly operator: number;
  readonly reset_schedule: string;
  readonly metadata: string;
  readonly title: string;
  readonly description: string;
  readonly category: number;
  readonly duration: number;
  readonly max_size: number;
  readonly max_num_score: number;
  readonly enable_ranks: number;
}

async function rowOf(tenantId: string, id: string): Promise<LeaderboardDbRow | null> {
  return env.DB.prepare(
    `SELECT authoritative, sort_order, operator, reset_schedule, metadata, title, description,
            category, duration, max_size, max_num_score, enable_ranks
     FROM leaderboard WHERE tenant_id = ?1 AND id = ?2`,
  )
    .bind(tenantId, id)
    .first<LeaderboardDbRow>();
}

/** 调一次 RPC 并**期望它失败**，返回模块看到的错误文案。 */
async function failureOf(world: RuntimeWorld, name: string, input = ""): Promise<string> {
  const invocation = await callTenantRpc(env, world.tenantId, callerOf(world), name, input);
  if (invocation.kind !== "error") throw new Error(`期望失败，实际是 ${invocation.kind}`);
  return invocation.message;
}

async function world(): Promise<RuntimeWorld> {
  const created = await runtimeWorld();
  await deployModules(created.tenantId, { game: MODULE });
  return created;
}

afterEach(() => resetRuntimeCache());

describe("M9 nk 创建面: 排行榜", () => {
  it("test_leaderboard_create_writes_the_given_configuration", async () => {
    const w = await world();
    expect(await payloadOf(w, "lb-create")).toBe("ok");
    const row = await rowOf(w.tenantId, "daily-wins");
    expect(row).not.toBeNull();
    expect(row?.authoritative).toBe(1);
    expect(row?.sort_order).toBe(0);
    expect(row?.operator).toBe(2);
    expect(row?.reset_schedule).toBe("0 0 * * *");
    expect(JSON.parse(row?.metadata ?? "{}")).toEqual({ level: 3 });
    expect(row?.enable_ranks).toBe(1);
    // 普通榜：不是锦标赛（`duration = 0`），也没有名额上限。
    expect(row?.duration).toBe(0);
    expect(row?.max_size).toBe(0);
  });

  it("test_a_second_create_is_idempotent_and_keeps_the_first_configuration", async () => {
    const w = await world();
    await payloadOf(w, "lb-create");
    expect(await payloadOf(w, "lb-create-again")).toBe("ok");
    const row = await rowOf(w.tenantId, "daily-wins");
    // 第二次给的是 desc/set/无重置/不排名，落库的仍然是第一次那一份。
    expect(row?.sort_order).toBe(0);
    expect(row?.operator).toBe(2);
    expect(row?.reset_schedule).toBe("0 0 * * *");
    expect(row?.enable_ranks).toBe(1);
  });
});

describe("M9 nk 创建面: 锦标赛", () => {
  it("test_tournament_create_writes_duration_and_catalog_fields", async () => {
    const w = await world();
    expect(await payloadOf(w, "tournament-create")).toBe("ok");
    const row = await rowOf(w.tenantId, "weekly-cup");
    expect(row?.duration).toBe(7200);
    expect(row?.title).toBe("Weekly Cup");
    expect(row?.description).toBe("Weekly tournament");
    expect(row?.category).toBe(7);
    expect(row?.max_num_score).toBe(3);
    expect(row?.enable_ranks).toBe(1);
    expect(row?.authoritative).toBe(1);
    expect(JSON.parse(row?.metadata ?? "{}")).toEqual({ theme: "spring" });
  });

  it("test_a_tournament_cannot_reuse_a_plain_leaderboard_id", async () => {
    const w = await world();
    await payloadOf(w, "lb-create");
    expect(await failureOf(w, "tournament-on-leaderboard")).toBe(
      "error creating tournament: cannot create tournament as leaderboard is already in use",
    );
  });
});

describe("M9 nk 创建面: 参数校验", () => {
  it("test_the_upstream_messages_are_reproduced_verbatim", async () => {
    const w = await world();
    const cases: readonly (readonly [string, string])[] = [
      ["no-id", "expects a leaderboard ID string"],
      ["bad-sort", "expects sort order to be 'asc' or 'desc'"],
      ["bad-operator", "expects operator to be 'best', 'set', 'decr' or 'incr'"],
      ["bad-bool", "expects boolean"],
      ["bad-cron", "expects reset schedule to be a valid CRON expression"],
      ["duration", "duration must be > 0"],
      ["category", "category must be 0-127"],
      [
        "end-before-start",
        "endTime must be > startTime. Use 0 to indicate a tournament that never ends.",
      ],
      [
        "end-before-reset",
        "error creating tournament: tournament end time cannot be before first reset schedule - " +
          "either increase end time or change/disable reset schedule",
      ],
    ];
    for (const [which, message] of cases) {
      expect([which, await failureOf(w, "validation", which)]).toEqual([which, message]);
    }
    // 校验都在写库之前：九次失败的调用没有留下任何一行。
    const rows = await env.DB.prepare("SELECT id FROM leaderboard WHERE tenant_id = ?1")
      .bind(w.tenantId)
      .all<{ id: string }>();
    expect(rows.results).toEqual([]);
  });
});
