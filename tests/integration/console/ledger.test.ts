import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { socialWorld } from "../../helpers/social-world";
import { basicAuth, call } from "../../helpers/tenants";

/**
 * M9 集成测试：控制台的钱包账本端点（DoD 6 的后半）。
 *
 * 反作弊点是**时间窗真的过滤了行**：造三行、用一个窗口只取到一行，
 * 而不是"返回 200 就算过"。游标那一半另外证明：翻页能取到下一页，
 * 而**换了时间窗再拿旧游标会被拒**（上游 `walletLedgerListCursor` 的
 * `after.Equal(cursor.After)` 就是干这个的，见 src/domain/console/ledger.ts）。
 *
 * 契约源（机器可读）：
 * 契约源: server/console_account.go::GetWalletLedger
 * 契约源: server/core_wallet.go::ListWalletLedger
 *
 * REQ-0001-021
 */

interface LedgerSeed {
  readonly id: string;
  readonly createTime: number;
  readonly value: number;
}

async function seed(tenantId: string, userId: string, rows: readonly LedgerSeed[]): Promise<void> {
  await env.DB.batch(
    rows.map((row) =>
      env.DB.prepare(
        `INSERT INTO wallet_ledger (tenant_id, id, user_id, changeset, metadata, create_time, update_time)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
      ).bind(
        tenantId,
        row.id,
        userId,
        JSON.stringify({ value: row.value }),
        "{}",
        row.createTime,
      ),
    ),
  );
}

interface LedgerResponse {
  readonly items: readonly { id: string; user_id: string; changeset: string }[];
  readonly next_cursor: string;
  readonly prev_cursor: string;
}

function ledgerPath(userId: string, query = ""): string {
  return `/v2/console/account/${userId}/wallet-ledger${query}`;
}

/**
 * 上游 `after` / `before` 是 `google.protobuf.Timestamp`，在 query 里是 RFC3339 文本
 * （grpc-gateway 按 well-known type 解析）。传裸秒数**不是**它的线格式，会被判非法。
 */
function rfc3339(seconds: number): string {
  return encodeURIComponent(new Date(seconds * 1000).toISOString());
}

const IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
] as const;

async function world3(): Promise<{ tenant: string; serverKey: string; userId: string; now: number }> {
  const world = await socialWorld(1);
  const now = Math.floor(Date.now() / 1000);
  const userId = world.accounts[0]?.id as string;
  await seed(world.tenant, userId, [
    { id: IDS[0], createTime: now - 30, value: 1 },
    { id: IDS[1], createTime: now - 20, value: 2 },
    { id: IDS[2], createTime: now - 10, value: 3 },
  ]);
  return { tenant: world.tenant, serverKey: world.serverKey, userId, now };
}

describe("M9 账本: 时间窗与分页", () => {
  it("test_the_after_window_really_filters_rows_out", async () => {
    const { serverKey, userId, now } = await world3();
    const response = await call(ledgerPath(userId, `?limit=10&after=${rfc3339(now - 25)}`), {
      authorization: basicAuth(serverKey),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as LedgerResponse;
    // 三行里只有后两行落在窗口内——`after` 不是装饰。
    expect(body.items.map((item) => item.id)).toEqual([IDS[2], IDS[1]]);
    expect(body.items[0]?.user_id).toBe(userId);
    expect(JSON.parse(body.items[0]?.changeset ?? "{}")).toEqual({ value: 3 });
  });

  it("test_the_before_window_trims_the_other_end", async () => {
    const { serverKey, userId, now } = await world3();
    const response = await call(ledgerPath(userId, `?limit=10&before=${rfc3339(now - 15)}`), {
      authorization: basicAuth(serverKey),
    });
    const body = (await response.json()) as LedgerResponse;
    expect(body.items.map((item) => item.id)).toEqual([IDS[1], IDS[0]]);
  });

  it("test_cursor_paging_walks_backwards_one_row_at_a_time", async () => {
    const { serverKey, userId } = await world3();
    const page1 = (await (
      await call(ledgerPath(userId, "?limit=1"), { authorization: basicAuth(serverKey) })
    ).json()) as LedgerResponse;
    expect(page1.items.map((item) => item.id)).toEqual([IDS[2]]);
    expect(page1.next_cursor).not.toBe("");

    const page2 = (await (
      await call(ledgerPath(userId, `?limit=1&cursor=${encodeURIComponent(page1.next_cursor)}`), {
        authorization: basicAuth(serverKey),
      })
    ).json()) as LedgerResponse;
    expect(page2.items.map((item) => item.id)).toEqual([IDS[1]]);
  });

  it("test_a_cursor_from_a_different_time_window_is_rejected", async () => {
    const { serverKey, userId, now } = await world3();
    const paged = (await (
      await call(ledgerPath(userId, `?limit=1&after=${rfc3339(now - 25)}`), {
        authorization: basicAuth(serverKey),
      })
    ).json()) as LedgerResponse;
    expect(paged.items.map((item) => item.id)).toEqual([IDS[2]]);

    // 同一个游标换一个时间窗 → 上游判非法，端点把它折成 Internal。
    const mismatched = await call(
      ledgerPath(
        userId,
        `?limit=1&after=${rfc3339(now - 5)}&cursor=${encodeURIComponent(paged.next_cursor)}`,
      ),
      { authorization: basicAuth(serverKey) },
    );
    expect(mismatched.status).toBe(500);
    expect(await mismatched.json()).toEqual({
      code: 13,
      message: "An error occurred while trying to list the user's wallet ledger.",
    });
  });

  it("test_a_malformed_timestamp_is_rejected_before_the_query_runs", async () => {
    const { serverKey, userId } = await world3();
    const response = await call(ledgerPath(userId, "?limit=5&after=yesterday"), {
      authorization: basicAuth(serverKey),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: 3,
      message: "Invalid after: expected an RFC3339 timestamp.",
    });
  });

  it("test_walking_back_up_the_list_swaps_the_two_cursors", async () => {
    const { serverKey, userId } = await world3();
    const page = async (query: string): Promise<LedgerResponse> =>
      (await (
        await call(ledgerPath(userId, query), { authorization: basicAuth(serverKey) })
      ).json()) as LedgerResponse;
    const cursor = (raw: string): { id: string; isNext: boolean } =>
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
        id: string;
        isNext: boolean;
      };

    const first = await page("?limit=1");
    expect(first.items.map((item) => item.id)).toEqual([IDS[2]]);
    expect(cursor(first.next_cursor).isNext).toBe(true);

    // 第二页往下一行；它的 `prev_cursor` 是"往回走"的锚（isNext=false）。
    const second = await page(`?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`);
    expect(second.items.map((item) => item.id)).toEqual([IDS[1]]);
    expect(cursor(second.prev_cursor).isNext).toBe(false);

    // 用 `prev_cursor` 回头：查询方向相反、结果要反转回来，且两个游标的角色互换——
    // 回头的下一页锚必须是 `isNext=true`，否则再往下走会原地打转。
    const back = await page(`?limit=1&cursor=${encodeURIComponent(second.prev_cursor)}`);
    expect(back.items.map((item) => item.id)).toEqual([IDS[2]]);
    expect(cursor(back.next_cursor).isNext).toBe(true);
    expect(back.prev_cursor).toBe("");
  });
});

describe("M9 账本: 参数校验与路径", () => {
  it("test_user_id_and_limit_are validated_independently", async () => {
    const world = await socialWorld(1);
    const missingId = await call(ledgerPath("not-a-uuid", "?limit=5"), {
      authorization: basicAuth(world.serverKey),
    });
    expect(missingId.status).toBe(400);
    expect(await missingId.json()).toEqual({ code: 3, message: "Requires a valid user ID." });

    for (const query of ["", "?limit=0", "?limit=101"]) {
      const response = await call(ledgerPath(world.accounts[0]?.id as string, query), {
        authorization: basicAuth(world.serverKey),
      });
      // 上游那句没有首字母大写、也没有句点，是它的原样。
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        code: 3,
        message: "expects a limit value between 1 and 100",
      });
    }
  });

  it("test_the_upstream_path_alias_serves_the_same_list", async () => {
    const { serverKey, userId } = await world3();
    const response = await call(`/v2/console/account/${userId}/wallet?limit=10`, {
      authorization: basicAuth(serverKey),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as LedgerResponse;
    expect(body.items.map((item) => item.id)).toEqual([IDS[2], IDS[1], IDS[0]]);
    // `EmitUnpopulated`：没有下一页时游标字段是空串而不是缺席。
    expect(body.next_cursor).toBe("");
    expect(body.prev_cursor).toBe("");
  });

  it("test_the_ledger_requires_a_server_key", async () => {
    const response = await call(ledgerPath(IDS[0], "?limit=1"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 16, message: "Server key required" });
  });
});
