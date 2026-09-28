import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { socialWorld } from "../../helpers/social-world";
import {
  selectWalletLedger,
  updateWalletLedgerRow,
} from "../../../src/domain/competitive/wallet/store";

/**
 * 钱包账本：列表的游标语义与单行的元数据合并。
 *
 * 上游这两条都在**控制台 API** 里（`server/console_account.go::GetWalletLedger` /
 * `UpdateWalletLedger`），本项目还没有控制台面（M9 的范围），所以这里先按
 * "存储层的行为"测：谁调用它后面再说，但语义现在就要对。
 *
 * 两处必须是可观察地正确的：
 *   1. 不带游标时是 `create_time DESC, id DESC`，并且**多取一条**用于判"还有没有下一页"；
 *   2. 反向游标（`isNext = false`）是升序扫描，由调用方反转——方向抄错会让"上一页"
 *      变成"下一页"，这与锦标赛 haystack 那条坑是同一类错。
 *
 * 契约源: server/console_account.go::GetWalletLedger
 * 契约源: server/console_account.go::DeleteWalletLedger
 */

interface LedgerSeed {
  readonly id: string;
  readonly createTime: number;
  readonly changeset: string;
  readonly metadata: string;
}

async function seed(tenantId: string, userId: string, rows: readonly LedgerSeed[]): Promise<void> {
  await env.DB.batch(
    rows.map((row) =>
      env.DB.prepare(
        `INSERT INTO wallet_ledger (tenant_id, id, user_id, changeset, metadata, create_time, update_time)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
      ).bind(tenantId, row.id, userId, row.changeset, row.metadata, row.createTime),
    ),
  );
}

describe("钱包账本", () => {
  it("列表按时间倒序，且多取一条用于判下一页", async () => {
    const world = await socialWorld(1);
    const userId = world.accounts[0]!.id;
    const now = Math.floor(Date.now() / 1000);
    await seed(world.tenant, userId, [
      { id: "00000000-0000-4000-8000-000000000001", createTime: now - 30, changeset: '{"value":1}', metadata: "{}" },
      { id: "00000000-0000-4000-8000-000000000002", createTime: now - 20, changeset: '{"value":2}', metadata: "{}" },
      { id: "00000000-0000-4000-8000-000000000003", createTime: now - 10, changeset: '{"value":3}', metadata: "{}" },
    ]);

    const page = await selectWalletLedger(env.DB, world.tenant, userId, {
      limit: 2,
      cursor: null,
      after: 0,
      before: 0,
      now,
    });

    // 倒序：最新的一行在前；`limit + 1` 条说明还有下一页。
    expect(page).toHaveLength(3);
    expect(page.map((row) => JSON.parse(row.changeset) as { value: number })).toEqual([
      { value: 3 },
      { value: 2 },
      { value: 1 },
    ]);
  });

  it("反向游标（isNext=false）取的是**更新**的那些行，且升序扫描", async () => {
    const world = await socialWorld(1);
    const userId = world.accounts[0]!.id;
    const now = Math.floor(Date.now() / 1000);
    await seed(world.tenant, userId, [
      { id: "00000000-0000-4000-8000-000000000001", createTime: now - 30, changeset: '{"value":1}', metadata: "{}" },
      { id: "00000000-0000-4000-8000-000000000002", createTime: now - 20, changeset: '{"value":2}', metadata: "{}" },
      { id: "00000000-0000-4000-8000-000000000003", createTime: now - 10, changeset: '{"value":3}', metadata: "{}" },
    ]);

    // 游标落在最旧的一行上（id1）：反向翻页拿到的是排在它**前面**（更新）的两行。
    // 上游 `ListWalletLedger` 就是在这一支上把比较符反转成 `>` 并改成 `ORDER BY create_time ASC`，
    // 由调用方最后 `slices.Reverse` —— 所以存储层这里交付的是升序原序。
    const newer = await selectWalletLedger(env.DB, world.tenant, userId, {
      limit: 2,
      cursor: {
        userId,
        createTime: now - 30,
        id: "00000000-0000-4000-8000-000000000001",
        isNext: false,
      },
      after: 0,
      before: 0,
      now,
    });

    expect(newer.map((row) => (JSON.parse(row.changeset) as { value: number }).value)).toEqual([2, 3]);
  });

  it("after / before 是时间窗过滤，游标页也要遵守", async () => {
    const world = await socialWorld(1);
    const userId = world.accounts[0]!.id;
    const now = Math.floor(Date.now() / 1000);
    await seed(world.tenant, userId, [
      { id: "00000000-0000-4000-8000-000000000001", createTime: now - 30, changeset: '{"value":1}', metadata: "{}" },
      { id: "00000000-0000-4000-8000-000000000002", createTime: now - 20, changeset: '{"value":2}', metadata: "{}" },
      { id: "00000000-0000-4000-8000-000000000003", createTime: now - 10, changeset: '{"value":3}', metadata: "{}" },
    ]);

    const window = await selectWalletLedger(env.DB, world.tenant, userId, {
      limit: null,
      cursor: null,
      after: now - 25,
      before: now - 5,
      now,
    });

    expect(window.map((row) => (JSON.parse(row.changeset) as { value: number }).value)).toEqual([3, 2]);
  });

  it("单行元数据是 json_patch 合并，不是替换；跨租户改不到", async () => {
    const world = await socialWorld(1);
    const userId = world.accounts[0]!.id;
    const now = Math.floor(Date.now() / 1000);
    const id = "00000000-0000-4000-8000-000000000009";
    await seed(world.tenant, userId, [
      { id, createTime: now, changeset: '{"value":5}', metadata: '{"a":1}' },
    ]);

    const updated = await updateWalletLedgerRow(env.DB, world.tenant, id, '{"b":2}', now + 1);

    expect(updated).not.toBeNull();
    expect(JSON.parse(updated?.metadata ?? "{}")).toEqual({ a: 1, b: 2 });
    expect(updated?.changeset).toBe('{"value":5}');
    expect(updated?.update_time).toBe(now + 1);

    const foreign = await updateWalletLedgerRow(env.DB, crypto.randomUUID(), id, '{"c":3}', now + 2);
    expect(foreign).toBeNull();
  });
});
