import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { resetRuntimeCache, tenantRuntime } from "../../../src/runtime/service";
import { deployModules, moduleRows, payloadOf, runtimeWorld, storageRows } from "./harness";

/**
 * 模块装载契约：装载一次、隔离到底、模块之间能互相 import。
 *
 * 逐条搬运 `server/runtime_test.go` 里那一组 Lua 用例的**可观测行为**：
 * TestRuntimeRequireEval（模块只评估一次）、TestRuntimeRequireFile /
 * TestRuntimeRequirePreload（一个模块引用另一个模块导出的函数）、
 * TestRuntimeSampleScript（只有顶层脚本、没有入口的模块也要能装载）、
 * TestRuntimeDisallowStandardLibs（模块碰不到宿主的标准库资源）。
 *
 * 载体不同（Lua require vs ESM import），断言的是同一件事：模块被评估一次、
 * 能被复用、拿不到宿主。
 *
 * 溯源: server/runtime_test.go::TestRuntimeRequireEval,TestRuntimeRequireFile,TestRuntimeRequirePreload,TestRuntimeSampleScript,TestRuntimeDisallowStandardLibs
 */

const STATE_MODULE = `
let initCount = 0;
let calls = 0;
export function InitModule(ctx, logger, nk, initializer) {
  initCount += 1;
  initializer.registerRpc("state", async (ctx, logger, nk) => {
    calls += 1;
    return JSON.stringify({ initCount, calls });
  });
}
`;

const PROBE_MODULE = `
export function InitModule(ctx, logger, nk, initializer) {
  initializer.registerRpc("probe", async () => {
    const out = { require: typeof require };
    try {
      await fetch("https://example.com");
      out.fetch = "allowed";
    } catch (error) {
      out.fetch = "blocked";
    }
    try {
      const fs = await import("node:fs");
      fs.readFileSync("/etc/passwd");
      out.hostFile = "readable";
    } catch (error) {
      out.hostFile = "blocked";
    }
    return JSON.stringify(out);
  });
}
`;

const STORAGE_MODULE = `
export function InitModule(ctx, logger, nk, initializer) {
  initializer.registerRpc("write", async (call, logger, nk, payload) => {
    await nk.storageWrite([
      { collection: "shared", key: "k", userId: call.userId, value: { from: payload } },
    ]);
    return "written";
  });
  initializer.registerRpc("read", async (call, logger, nk) => {
    const rows = await nk.storageRead([
      { collection: "shared", key: "k", userId: call.userId },
    ]);
    return JSON.stringify(rows.map((row) => row.value));
  });
}
`;

const STATS_MODULE = `
export function mean(values) {
  let sum = 0;
  let count = 0;
  for (const value of values) {
    if (typeof value === "number") {
      sum += value;
      count += 1;
    }
  }
  return sum / count;
}
`;

const USES_STATS_MODULE = `
import * as stats from "./stats.js";
export function InitModule(ctx, logger, nk, initializer) {
  initializer.registerRpc("mean", async () => String(stats.mean([5, 7, 8, "ignored"])));
}
`;

const SAMPLE_SCRIPT_MODULE = `
globalThis.__musterSampleLoaded = "yes";
`;

const READS_SAMPLE_MODULE = `
export function InitModule(ctx, logger, nk, initializer) {
  initializer.registerRpc("sample", async () => String(globalThis.__musterSampleLoaded));
}
`;

afterEach(() => resetRuntimeCache());

describe("M8 运行时: 装载一次", () => {
  it("test_init_module_runs_exactly_once_and_module_state_survives", async () => {
    const world = await runtimeWorld();
    await deployModules(world.tenantId, { game: STATE_MODULE });

    // 两次调用之间是同一个 isolate：initCount 停在 1（没有被重新初始化），
    // calls 从 1 走到 2（模块级状态跨调用保留）。
    expect(JSON.parse(await payloadOf(world, "state"))).toEqual({ initCount: 1, calls: 1 });
    expect(JSON.parse(await payloadOf(world, "state"))).toEqual({ initCount: 1, calls: 2 });
  });

  it("test_the_runtime_reports_the_deployed_module_names", async () => {
    const world = await runtimeWorld();
    await deployModules(world.tenantId, { game: STATE_MODULE, stats: STATS_MODULE });
    const runtime = await tenantRuntime(env, world.tenantId);
    expect(runtime?.names).toEqual(["game", "stats"]);
    expect(await moduleRows(world.tenantId)).toHaveLength(2);
  });
});

describe("M8 运行时: 隔离", () => {
  it("test_a_module_cannot_reach_the_host", async () => {
    const world = await runtimeWorld();
    await deployModules(world.tenantId, { probe: PROBE_MODULE });
    const out = JSON.parse(await payloadOf(world, "probe")) as Record<string, string>;
    expect(out.fetch).toBe("blocked");
    expect(out.hostFile).toBe("blocked");
    expect(out.require).toBe("undefined");
  });

  it("test_the_same_user_and_collection_in_two_tenants_stay_apart", async () => {
    const a = await runtimeWorld();
    const b = await runtimeWorld();
    await deployModules(a.tenantId, { game: STORAGE_MODULE });
    await deployModules(b.tenantId, { game: STORAGE_MODULE });

    await payloadOf(a, "write", "a");
    await payloadOf(b, "write", "b");

    // 同一个用户 id、同一个集合、同一个键：两边各读各的那一份。
    expect(JSON.parse(await payloadOf(a, "read"))).toEqual([{ from: "a" }]);
    expect(JSON.parse(await payloadOf(b, "read"))).toEqual([{ from: "b" }]);
    expect(await storageRows(a.tenantId, "shared")).toHaveLength(1);
    expect(await storageRows(b.tenantId, "shared")).toHaveLength(1);
  });
});

describe("M8 运行时: 模块之间", () => {
  it("test_one_module_can_import_another_by_name", async () => {
    const world = await runtimeWorld();
    await deployModules(world.tenantId, { stats: STATS_MODULE, "use-stats": USES_STATS_MODULE });
    // (5 + 7 + 8) / 3，字符串那一项被 mean 自己跳过。
    expect(await payloadOf(world, "mean")).toBe(String(20 / 3));
  });

  it("test_a_script_module_without_init_module_is_still_evaluated", async () => {
    const world = await runtimeWorld();
    await deployModules(world.tenantId, { sample: SAMPLE_SCRIPT_MODULE, reader: READS_SAMPLE_MODULE });
    expect(await payloadOf(world, "sample")).toBe("yes");
  });
});
