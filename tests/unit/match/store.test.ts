import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { MatchListFilters, MatchRecord } from "../../../src/domain/match/catalog";
import {
  deleteMatchRecord,
  listMatchRecords,
  updateMatchRecordLabel,
  updateMatchRecordSize,
  upsertMatchRecord,
} from "../../../src/domain/match/store";

/**
 * M7 契约：对局目录的存储层（`match_record`，`GET /v2/match` 的数据源）。
 *
 * 上游把这份数据放在 bluge 内存索引里，本项目落成 D1 表（ECN-0011 偏差 2）。
 * 换存储不改行为，但**每条 SQL 的租户条件**是新加的硬约束（ECN-0001），
 * 所以这里逐条钉：读、写、改标签、改人数、删、以及"别人的行看不见"。
 *
 * 每个用例一个随机租户 = 一套全新的行，比"跑完清表"可靠（同一文件里的 D1 是持久的）。
 *
 * 契约源（机器可读）：
 * 契约源: server/match_registry.go::LocalMatchRegistry.ListMatches
 * 契约源: server/match_registry.go::LocalMatchRegistry.UpdateMatchLabel
 *
 * REQ-0001-018
 */

const DB = env.DB;

function tenant(): string {
  return crypto.randomUUID().toUpperCase();
}

function record(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    matchId: `${crypto.randomUUID()}.muster`,
    node: "muster",
    authoritative: true,
    label: "",
    size: 1,
    createTime: 1_700_000_000,
    ...overrides,
  };
}

const ALL: MatchListFilters = {
  limit: 100,
  authoritative: undefined,
  label: undefined,
  minSize: undefined,
  maxSize: undefined,
  query: undefined,
};

function filters(overrides: Partial<MatchListFilters> = {}): MatchListFilters {
  return { ...ALL, ...overrides };
}

describe("M7 契约: 对局目录的存储层", () => {
  it("test_write_then_read_returns_the_same_fields", async () => {
    const id = tenant();
    const row = record({ label: '{"skill":60}', size: 3 });
    await upsertMatchRecord(DB, id, row);

    expect(await listMatchRecords(DB, id, filters())).toEqual([row]);
  });

  it("test_a_second_write_updates_label_and_size_but_keeps_create_time", async () => {
    const id = tenant();
    const row = record({ label: "first", size: 1, createTime: 1_700_000_000 });
    await upsertMatchRecord(DB, id, row);
    // 同 id 再写一次：主键冲突走 UPDATE，创建时间不参与更新。
    await upsertMatchRecord(DB, id, { ...row, label: "second", size: 4, createTime: 1_800_000_000 });

    const [stored] = await listMatchRecords(DB, id, filters());
    expect(stored?.label).toBe("second");
    expect(stored?.size).toBe(4);
    expect(stored?.createTime).toBe(1_700_000_000);
  });

  it("test_size_and_label_can_be_updated_on_their_own", async () => {
    const id = tenant();
    const row = record({ label: "before" });
    await upsertMatchRecord(DB, id, row);

    await updateMatchRecordSize(DB, id, row.matchId, 7);
    await updateMatchRecordLabel(DB, id, row.matchId, "after");

    const [stored] = await listMatchRecords(DB, id, filters());
    expect(stored?.size).toBe(7);
    expect(stored?.label).toBe("after");
  });

  it("test_deleting_a_row_takes_it_out_of_the_listing", async () => {
    const id = tenant();
    const row = record();
    await upsertMatchRecord(DB, id, row);
    await deleteMatchRecord(DB, id, row.matchId);
    expect(await listMatchRecords(DB, id, filters())).toEqual([]);
  });

  it("test_rows_of_another_tenant_are_invisible", async () => {
    const mine = tenant();
    const theirs = tenant();
    await upsertMatchRecord(DB, theirs, record({ label: "not-yours" }));
    expect(await listMatchRecords(DB, mine, filters())).toEqual([]);
  });

  it("test_limit_zero_reads_nothing_at_all", async () => {
    const id = tenant();
    await upsertMatchRecord(DB, id, record());
    // limit=0 是"一条都不要"，与"没有对局"区分不开但语义不同。
    expect(await listMatchRecords(DB, id, filters({ limit: 0 }))).toEqual([]);
  });

  it("test_the_listing_orders_by_create_time_descending_then_match_id", async () => {
    const id = tenant();
    const newer = record({ createTime: 1_700_000_100, matchId: `ffffffff-0000-4000-8000-00000000000a.muster` });
    const olderB = record({ createTime: 1_700_000_000, matchId: `bbbbbbbb-0000-4000-8000-00000000000b.muster` });
    const olderA = record({ createTime: 1_700_000_000, matchId: `aaaaaaaa-0000-4000-8000-00000000000a.muster` });
    await upsertMatchRecord(DB, id, newer);
    await upsertMatchRecord(DB, id, olderB);
    await upsertMatchRecord(DB, id, olderA);

    const listed = await listMatchRecords(DB, id, filters());
    expect(listed.map((entry) => entry.matchId)).toEqual([newer.matchId, olderA.matchId, olderB.matchId]);
  });

  it("test_the_label_filter_is_a_whole_string_comparison", async () => {
    const id = tenant();
    await upsertMatchRecord(DB, id, record({ label: "label-part2" }));
    await upsertMatchRecord(DB, id, record({ label: "label" }));

    const exact = await listMatchRecords(DB, id, filters({ label: "label-part2" }));
    expect(exact).toHaveLength(1);
    // 被分词器切开才会出现的"半串命中"在这里必须搜不到。
    expect(await listMatchRecords(DB, id, filters({ label: "part2" }))).toEqual([]);
  });
});
