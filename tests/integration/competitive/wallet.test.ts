import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { socialWorld, type SocialWorld } from "../../helpers/social-world";
import { bearer, call } from "../../helpers/tenants";
import { WALLET_DEDUCTIONS, WALLET_TOTAL, WALLET_VALUES } from "../../helpers/wallet-values";
import {
  readWallet,
  updateWallet,
  updateWallets,
} from "../../../src/domain/competitive/wallet/service";
import { buildWalletWriteStatements } from "../../../src/domain/competitive/wallet/store";
import { WalletNegativeError } from "../../../src/domain/competitive/wallet/types";

/**
 * 钱包批量更新：累加、原子性、账本。
 *
 * 七条用例逐条搬运自上游 `core_wallet_test.go`——那七条测的其实只有四件事，
 * 但每一条都用"41 个数字跑满"的方式把它们叠在一起：
 *   1. 累加不漏（顺序写 + 并发写都要收敛到 984）；
 *   2. 同一批里同一用户出现多次要**在内存里累加**（不是各写各的覆盖）；
 *   3. 不存在的用户被跳过；
 *   4. 扣成负数 → 整批回滚。
 *
 * 与上游的唯一实现差异是并发控制（CAS + 同租户队列取代 `SELECT ... FOR UPDATE`），
 * 所以"并发写"这一条的写法也相应变成"同一时刻发出去的一批 promise"。
 *
 * 溯源: server/core_wallet_test.go::TestUpdateWalletSingleUser
 * 溯源: server/core_wallet_test.go::TestUpdateWalletMultiUser
 * 溯源: server/core_wallet_test.go::TestUpdateWalletsMultiUser
 * 溯源: server/core_wallet_test.go::TestUpdateWalletsMultiUserSharedChangeset
 * 溯源: server/core_wallet_test.go::TestUpdateWalletsMultiUserSharedChangesetDeductions
 * 溯源: server/core_wallet_test.go::TestUpdateWalletsSingleUser
 * 溯源: server/core_wallet_test.go::TestUpdateWalletRepeatedSingleUser
 */

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function walletValue(world: SocialWorld, userId: string): Promise<number> {
  const wallet = JSON.parse(await readWallet(env.DB, world.tenant, userId)) as Record<string, number>;
  return wallet.value ?? -1;
}

describe("钱包批量更新", () => {
  it("单用户：一半顺序写、一半并发写，最终仍然是 984", async () => {
    const world = await socialWorld(1);
    const user = (world.accounts[0] as { id: string }).id;
    const half = WALLET_VALUES.length / 2;

    for (const value of WALLET_VALUES.slice(0, half)) {
      await updateWallet(env.DB, world.tenant, nowSec(), user, { value }, "", false);
    }
    await Promise.all(
      WALLET_VALUES.slice(half).map((value) =>
        updateWallet(env.DB, world.tenant, nowSec(), user, { value }, "", false),
      ),
    );

    expect(await walletValue(world, user)).toBe(WALLET_TOTAL);

    // 客户端看得见的那一面：`GET /v2/account` 的 wallet 是 JSON 文本。
    const response = await call("/v2/account", { authorization: bearer(world.accounts[0]!.token) });
    expect(response.status).toBe(200);
    const account = (await response.json()) as { wallet: string };
    expect(JSON.parse(account.wallet)).toEqual({ value: WALLET_TOTAL });
  });

  it("多用户：同一个用户被连续写 41 轮，五个钱包各自收敛到 984", async () => {
    const world = await socialWorld(5);
    for (const value of WALLET_VALUES) {
      for (const account of world.accounts) {
        await updateWallet(env.DB, world.tenant, nowSec(), account.id, { value }, "", true);
      }
    }
    for (const account of world.accounts) {
      expect(await walletValue(world, account.id)).toBe(WALLET_TOTAL);
    }
  });

  it("多用户批量：一次调用同时更新五个用户", async () => {
    const world = await socialWorld(5);
    for (const value of WALLET_VALUES) {
      const updates = world.accounts.map((account) => ({
        userId: account.id,
        changeset: { value },
        metadata: "",
      }));
      await updateWallets(env.DB, world.tenant, nowSec(), updates, true);
    }
    for (const account of world.accounts) {
      expect(await walletValue(world, account.id)).toBe(WALLET_TOTAL);
    }
  });

  it("多用户批量：五个用户共享同一份 changeset 对象也各自累加", async () => {
    const world = await socialWorld(5);
    for (const value of WALLET_VALUES) {
      const changeset = { value };
      await updateWallets(
        env.DB,
        world.tenant,
        nowSec(),
        world.accounts.map((account) => ({ userId: account.id, changeset, metadata: "" })),
        true,
      );
    }
    for (const account of world.accounts) {
      expect(await walletValue(world, account.id)).toBe(WALLET_TOTAL);
    }
  });

  it("共享 changeset 且带扣款：正负相消之后是 0", async () => {
    const world = await socialWorld(5);
    let foo = 1;
    for (const value of WALLET_DEDUCTIONS) {
      const changeset = { value, foo };
      await updateWallets(
        env.DB,
        world.tenant,
        nowSec(),
        world.accounts.map((account) => ({ userId: account.id, changeset, metadata: "" })),
        true,
      );
      foo = foo === 1 ? -1 : 1;
    }
    for (const account of world.accounts) {
      expect(await walletValue(world, account.id)).toBe(0);
    }
  });

  it("一次调用里给同一个用户三条 update：累加成 6", async () => {
    const world = await socialWorld(1);
    const user = (world.accounts[0] as { id: string }).id;

    const results = await updateWallets(
      env.DB,
      world.tenant,
      nowSec(),
      [
        { userId: user, changeset: { value: 1 }, metadata: "" },
        { userId: user, changeset: { value: 2 }, metadata: "" },
        { userId: user, changeset: { value: 3 }, metadata: "" },
      ],
      true,
    );

    expect(results).toHaveLength(3);
    expect(results.map((result) => result.updated?.value)).toEqual([1, 3, 6]);
    expect(await walletValue(world, user)).toBe(6);
  });

  it("重复单次调用（不写账本）也是累加：6", async () => {
    const world = await socialWorld(1);
    const user = (world.accounts[0] as { id: string }).id;

    await updateWallet(env.DB, world.tenant, nowSec(), user, { value: 1 }, "", false);
    await updateWallet(env.DB, world.tenant, nowSec(), user, { value: 2 }, "", false);
    await updateWallet(env.DB, world.tenant, nowSec(), user, { value: 3 }, "", false);

    expect(await walletValue(world, user)).toBe(6);
  });

  it("不存在的用户被跳过，既不报错也不产生结果", async () => {
    const world = await socialWorld(1);
    const user = (world.accounts[0] as { id: string }).id;

    const results = await updateWallets(
      env.DB,
      world.tenant,
      nowSec(),
      [
        { userId: user, changeset: { value: 5 }, metadata: "" },
        { userId: crypto.randomUUID().toUpperCase(), changeset: { value: 5 }, metadata: "" },
      ],
      true,
    );

    expect(results).toHaveLength(1);
    expect(await walletValue(world, user)).toBe(5);
  });

  it("扣成负数：整批不落库，所有结果的 updated 都被清成 undefined", async () => {
    const world = await socialWorld(2);
    const [first, second] = world.accounts as unknown as [{ id: string }, { id: string }];

    const failure = await updateWallets(
      env.DB,
      world.tenant,
      nowSec(),
      [
        { userId: first.id, changeset: { value: 10 }, metadata: "" },
        { userId: second.id, changeset: { value: -1 }, metadata: "" },
      ],
      true,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WalletNegativeError);
    expect((failure as WalletNegativeError).path).toBe("value");
    // 关键：连"排在前面的那个用户"也没有被写进去——这就是事务性。
    expect(await walletValue(world, first.id)).toBe(-1);
    expect(await walletValue(world, second.id)).toBe(-1);
  });

  it("CAS 守卫：批次里有一条写不进去就整体回滚", async () => {
    const world = await socialWorld(2);
    const [first, second] = world.accounts as unknown as [{ id: string }, { id: string }];
    await updateWallet(env.DB, world.tenant, nowSec(), second.id, { value: 1 }, "", false);

    // 手工构造一个"旧值已过期"的批次：第二条的 previous 不是库里的现状。
    const statements = buildWalletWriteStatements(
      env.DB,
      world.tenant,
      nowSec(),
      [
        { userId: first.id, previousJson: "{}", nextJson: '{"value":7}' },
        { userId: second.id, previousJson: "{}", nextJson: '{"value":7}' },
      ],
      [],
    );

    await expect(env.DB.batch(statements)).rejects.toThrow();
    // 第一条虽然 CAS 成功过，但整批回滚之后它也必须没写进去。
    expect(await walletValue(world, first.id)).toBe(-1);
    expect(await walletValue(world, second.id)).toBe(1);
  });

  it("updateLedger=true 时每条 update 写一行账本", async () => {
    const world = await socialWorld(1);
    const user = (world.accounts[0] as { id: string }).id;

    await updateWallets(
      env.DB,
      world.tenant,
      nowSec(),
      [
        { userId: user, changeset: { value: 1 }, metadata: "" },
        { userId: user, changeset: { value: 2 }, metadata: '{"reason":"quest"}' },
      ],
      true,
    );

    const rows = await env.DB.prepare(
      "SELECT changeset, metadata FROM wallet_ledger WHERE tenant_id = ?1 AND user_id = ?2 ORDER BY create_time, id",
    )
      .bind(world.tenant, user)
      .all<{ changeset: string; metadata: string }>();

    expect(rows.results).toHaveLength(2);
    // 两条账本落在同一秒（本项目时间精度到秒），所以这里按内容断言而不是按行序——
    // 上游的 timestamptz 有微秒精度，能区分先后的那份信息在我们的表示里不存在。
    const changesets = rows.results.map((row) => JSON.parse(row.changeset) as { value: number });
    expect(changesets.map((entry) => entry.value).sort()).toEqual([1, 2]);
    const quest = rows.results.find(
      (row) => (JSON.parse(row.changeset) as { value: number }).value === 2,
    );
    expect(quest?.metadata).toBe('{"reason":"quest"}');
  });
});
