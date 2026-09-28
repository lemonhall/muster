import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { callTenantRpc, resetRuntimeCache } from "../../../src/runtime/service";
import { callerOf, deployModules, payloadOf, runtimeWorld, type RuntimeWorld } from "./harness";

/**
 * M9 运行时面：权威写分与钱包账本（DoD 7 的后半）。
 *
 * 权威写那一半是 v2 的 ECN-0010 偏差 10 里"`authoritative = 1` 的榜没人能写分"的收尾：
 * 模块调用者是平台的 `uuid.Nil`，所以它写得进去；**客户端**仍然 403——后者由
 * `tests/integration/competitive/leaderboard.test.ts` 的 authoritative 用例钉着，
 * 这里补的是另一半。断言一律读库里的行。
 *
 * 账本那一半走的是与控制台端点**同一个** `ListWalletLedger`，所以这里额外钉住两个面
 * 的**形状差异**：运行时给的是对象（`changeset` / `metadata`），控制台给的是字符串；
 * 运行时到底时 `cursor` 是 `null` 而不是空串。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.leaderboardRecordWrite
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.walletLedgerList
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.walletLedgerUpdate
 *
 * REQ-0001-014, REQ-0001-015
 */

const MODULE = `
export function InitModule(ctx, logger, nk, initializer) {
  initializer.registerRpc("record-write", async (call, logger, nk) => {
    // 名次缓存开着，写分才会带 rank（上游同样只在 enableRanks 时算名次）。
    await nk.leaderboardCreate("auth-board", true, "desc", "best", null, null, true);
    const record = await nk.leaderboardRecordWrite(
      "auth-board", call.userId, call.username, 42, 7, { note: "from-module" },
    );
    return JSON.stringify(record);
  });

  initializer.registerRpc("record-delete", async (call, logger, nk) => {
    await nk.leaderboardRecordDelete("auth-board", call.userId);
    return "ok";
  });

  initializer.registerRpc("record-missing-board", async (call, logger, nk) => {
    await nk.leaderboardRecordWrite("nope", call.userId, call.username, 1);
    return "ok";
  });

  initializer.registerRpc("ledger-seed", async (call, logger, nk) => {
    await nk.walletUpdate(call.userId, { coins: 10 }, { note: "daily" }, true);
    return "ok";
  });

  initializer.registerRpc("ledger-list", async (call, logger, nk, limit) => {
    return JSON.stringify(await nk.walletLedgerList(call.userId, Number(limit), ""));
  });

  initializer.registerRpc("ledger-page", async (call, logger, nk, cursor) => {
    return JSON.stringify(await nk.walletLedgerList(call.userId, 1, cursor));
  });

  initializer.registerRpc("ledger-update", async (call, logger, nk, itemId) => {
    return JSON.stringify(await nk.walletLedgerUpdate(itemId, { note: "refunded" }));
  });
}
`;

interface LedgerItem {
  readonly id: string;
  readonly userId: string;
  readonly changeset: Record<string, number>;
  readonly metadata: Record<string, unknown>;
  readonly createTime: number;
  readonly updateTime: number;
}

async function failureOf(world: RuntimeWorld, name: string, input = ""): Promise<string> {
  const invocation = await callTenantRpc(env, world.tenantId, callerOf(world), name, input);
  if (invocation.kind !== "error") throw new Error(`期望失败，实际是 ${invocation.kind}`);
  return invocation.message;
}

/** 直接种三行账本：`create_time` 错开，翻页的顺序才是确定的。 */
async function seedLedger(tenantId: string, userId: string): Promise<readonly string[]> {
  const now = Math.floor(Date.now() / 1000);
  const ids = [
    "00000000-0000-4000-8000-00000000000A",
    "00000000-0000-4000-8000-00000000000B",
    "00000000-0000-4000-8000-00000000000C",
  ];
  await env.DB.batch(
    ids.map((id, index) =>
      env.DB.prepare(
        `INSERT INTO wallet_ledger (tenant_id, id, user_id, changeset, metadata, create_time, update_time)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
      ).bind(
        tenantId,
        id,
        userId,
        JSON.stringify({ coins: index + 1 }),
        JSON.stringify({ seq: index }),
        now - (3 - index) * 10,
      ),
    ),
  );
  return ids;
}

async function world(): Promise<RuntimeWorld> {
  const created = await runtimeWorld();
  await deployModules(created.tenantId, { game: MODULE });
  return created;
}

afterEach(() => resetRuntimeCache());

describe("M9 nk 权威写分", () => {
  it("test_a_module_can_write_to_an_authoritative_leaderboard", async () => {
    const w = await world();
    const record = JSON.parse(await payloadOf(w, "record-write")) as Record<string, unknown>;

    // 上游 `leaderboardRecordToJsMap` 是 camelCase，且 `score` / `subscore` 是数字。
    expect(record["leaderboardId"]).toBe("auth-board");
    expect(record["ownerId"]).toBe(w.userId);
    expect(record["username"]).toBe(w.username);
    expect(record["score"]).toBe(42);
    expect(record["subscore"]).toBe(7);
    expect(record["rank"]).toBe(1);
    expect(record["metadata"]).toEqual({ note: "from-module" });
    expect(record["expiryTime"]).toBeNull();

    const row = await env.DB.prepare(
      `SELECT score, subscore, username, metadata FROM leaderboard_record
       WHERE tenant_id = ?1 AND leaderboard_id = ?2 AND owner_id = ?3`,
    )
      .bind(w.tenantId, "auth-board", w.userId)
      .first<{ score: number; subscore: number; username: string; metadata: string }>();
    expect(row?.score).toBe(42);
    expect(row?.subscore).toBe(7);
    expect(row?.username).toBe(w.username);
    expect(JSON.parse(row?.metadata ?? "{}")).toEqual({ note: "from-module" });
  });

  it("test_record_delete_removes_the_row", async () => {
    const w = await world();
    await payloadOf(w, "record-write");
    expect(await payloadOf(w, "record-delete")).toBe("ok");
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM leaderboard_record WHERE tenant_id = ?1 AND leaderboard_id = ?2",
    )
      .bind(w.tenantId, "auth-board")
      .first<{ total: number }>();
    expect(row?.total).toBe(0);
  });

  it("test_writing_to_a_missing_leaderboard_reports_the_upstream_error", async () => {
    const w = await world();
    expect(await failureOf(w, "record-missing-board")).toBe(
      "error writing leaderboard record: Leaderboard not found.",
    );
  });
});

describe("M9 nk 账本", () => {
  it("test_wallet_update_with_ledger_lands_as_an_object_shaped_item", async () => {
    const w = await world();
    await payloadOf(w, "ledger-seed");
    const page = JSON.parse(await payloadOf(w, "ledger-list", "10")) as {
      items: LedgerItem[];
      cursor: string | null;
    };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.userId).toBe(w.userId);
    // 对象（不是控制台那条线格式的字符串），元数据也是对象。
    expect(page.items[0]?.changeset).toEqual({ coins: 10 });
    expect(page.items[0]?.metadata).toEqual({ note: "daily" });
    // 到底了：`null`，不是空串、也不是缺字段。
    expect(page.cursor).toBeNull();
  });

  it("test_paging_walks_every_row_once_and_in_descending_time_order", async () => {
    const w = await world();
    const ids = await seedLedger(w.tenantId, w.userId);
    const seen: string[] = [];
    let cursor = "";
    for (let page = 0; page < 4; page += 1) {
      const body = JSON.parse(await payloadOf(w, "ledger-page", cursor)) as {
        items: LedgerItem[];
        cursor: string | null;
      };
      seen.push(...body.items.map((item) => item.id));
      if (body.cursor === null) break;
      cursor = body.cursor;
    }
    // 三行、不重不漏、从新到旧。
    expect(seen).toEqual([ids[2], ids[1], ids[0]]);
  });

  it("test_ledger_update_merges_metadata_and_returns_the_stored_row", async () => {
    const w = await world();
    const [id] = await seedLedger(w.tenantId, w.userId);
    const item = JSON.parse(await payloadOf(w, "ledger-update", id as string)) as LedgerItem & {
      changeset: Record<string, unknown>;
    };
    expect(item.id).toBe(id);
    expect(item.userId).toBe(w.userId);
    // `metadata = metadata || $2` 是**合并**：`seq` 留着，`note` 补上。
    expect(item.metadata).toEqual({ seq: 0, note: "refunded" });
    // 上游把入参当 changeset 回填。
    expect(item.changeset).toEqual({ note: "refunded" });

    const row = await env.DB.prepare(
      "SELECT metadata FROM wallet_ledger WHERE tenant_id = ?1 AND id = ?2",
    )
      .bind(w.tenantId, id)
      .first<{ metadata: string }>();
    expect(JSON.parse(row?.metadata ?? "{}")).toEqual({ seq: 0, note: "refunded" });
  });

  it("test_updating_a_missing_ledger_item_reports_the_upstream_error", async () => {
    const w = await world();
    expect(await failureOf(w, "ledger-update", "00000000-0000-4000-8000-0000000000FF")).toBe(
      "failed to update user wallet ledger: no rows in result set",
    );
  });
});
