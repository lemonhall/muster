import { describe, expect, it } from "vitest";

import {
  decodePartyCursor,
  encodePartyCursor,
  listParties,
} from "../../../src/domain/party/catalog";
import type { PartyListFilters, PartyRecord } from "../../../src/domain/party/types";

/**
 * M8 派对目录：过滤、排序、翻页、游标一致性校验。
 *
 * 上游把目录放在 bluge 内存索引里；本项目换成 D1 表（ECN-0013 偏差 2），但
 * **筛选语义一致**：`open` 三态、`label.<key>` 查询、`limit` 分页、游标里带着
 * `query`/`limit`/`open` 三项并在下一次请求时逐项比对。
 *
 * 唯一刻意不同的是排序：上游 bluge 的 `TopNSearch` 在空查询下顺序由索引内部
 * 结构决定（不可复现），这里固定成 `create_time DESC, party_id ASC`。
 *
 * 契约源（机器可读）：
 * 契约源: server/party_registry.go::LocalPartyRegistry.PartyList
 * 契约源: server/party_registry.go::LocalPartyRegistry.LabelUpdate
 *
 * REQ-0001-019
 */

function record(
  uuid: string,
  createTime: number,
  input: { readonly open?: boolean; readonly hidden?: boolean; readonly label?: string } = {},
): PartyRecord {
  return {
    partyId: `${uuid}.muster`,
    uuid,
    node: "muster",
    open: input.open ?? true,
    hidden: input.hidden ?? false,
    maxSize: 4,
    label: input.label ?? "{}",
    createTime,
  };
}

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";

function filters(input: Partial<PartyListFilters> = {}): PartyListFilters {
  return { limit: 10, open: undefined, query: undefined, offset: undefined, ...input };
}

describe("M8 目录: 过滤与排序", () => {
  it("test_newest_first_then_by_id", () => {
    const page = listParties(
      [record(U1, 100), record(U2, 300), record(U3, 100)],
      filters(),
    );
    // 时间相同的那两条按 party_id 升序（可复现，不依赖索引内部顺序）。
    expect(page.parties.map((one) => one.uuid)).toEqual([U2, U1, U3]);
  });

  it("test_open_three_states", () => {
    const records = [record(U1, 1, { open: true }), record(U2, 2, { open: false })];
    expect(listParties(records, filters()).parties).toHaveLength(2);
    expect(listParties(records, filters({ open: true })).parties.map((one) => one.uuid)).toEqual([U1]);
    expect(listParties(records, filters({ open: false })).parties.map((one) => one.uuid)).toEqual([U2]);
  });

  it("test_empty_and_star_queries_match_everything", () => {
    const records = [record(U1, 1), record(U2, 2, { label: "{\"region\":\"eu\"}" })];
    expect(listParties(records, filters()).parties).toHaveLength(2);
    expect(listParties(records, filters({ query: "*" })).parties).toHaveLength(2);
  });

  it("test_label_terms_are_flattened_into_queryable_fields", () => {
    const records = [
      record(U1, 1, { label: "{\"region\":\"eu\",\"level\":5}" }),
      record(U2, 2, { label: "{\"region\":\"na\",\"level\":9}" }),
      record(U3, 3, { label: "{\"tags\":[\"eu\",\"sea\"]}" }),
    ];
    expect(
      listParties(records, filters({ query: "+label.region:eu" })).parties.map((one) => one.uuid),
    ).toEqual([U1]);
    expect(
      listParties(records, filters({ query: "+label.level:>=6" })).parties.map((one) => one.uuid),
    ).toEqual([U2]);
    // 数组的每个元素各算一项，与上游一致。
    expect(
      listParties(records, filters({ query: "+label.tags:sea" })).parties.map((one) => one.uuid),
    ).toEqual([U3]);
  });

  it("test_a_label_that_is_not_a_json_object_has_no_queryable_fields", () => {
    // 库里存着坏标签（只有手工改过才会发生）：查询串命中不了它，但不炸。
    const broken = record(U1, 1, { label: "not json" });
    expect(listParties([broken], filters({ query: "+label.region:eu" })).parties).toEqual([]);
    expect(listParties([broken], filters()).parties).toHaveLength(1);
  });
});

describe("M8 目录: 翻页与游标", () => {
  it("test_paging_walks_every_row_without_gaps_or_repeats", () => {
    const records = [record(U1, 30), record(U2, 20), record(U3, 10)];
    const first = listParties(records, filters({ limit: 2 }));
    expect(first.parties.map((one) => one.uuid)).toEqual([U1, U2]);
    expect(first.cursor).not.toBe("");

    const second = listParties(records, {
      ...filters({ limit: 2 }),
      offset: decodePartyCursor(first.cursor, { query: "*", open: undefined, limit: 2 }).offset,
    });
    expect(second.parties.map((one) => one.uuid)).toEqual([U3]);
    // 最后一页不再给游标。
    expect(second.cursor).toBe("");
  });

  it("test_cursor_round_trips_the_three_params", () => {
    const cursor = encodePartyCursor({ query: "+label.a:1", open: false, offset: 4, limit: 3 });
    expect(decodePartyCursor(cursor, { query: "+label.a:1", open: false, limit: 3 })).toEqual({
      query: "+label.a:1",
      open: false,
      offset: 4,
      limit: 3,
    });
  });

  it("test_cursor_mismatches_report_the_upstream_wording", () => {
    const cursor = encodePartyCursor({ query: "*", open: true, offset: 2, limit: 2 });
    expect(() => decodePartyCursor(cursor, { query: "+label.a:1", open: true, limit: 2 })).toThrow(
      "invalid cursor: param query mismatch",
    );
    expect(() => decodePartyCursor(cursor, { query: "*", open: true, limit: 5 })).toThrow(
      "invalid cursor: param limit mismatch",
    );
    expect(() => decodePartyCursor(cursor, { query: "*", open: false, limit: 2 })).toThrow(
      "invalid cursor: param open mismatch",
    );
  });

  it("test_malformed_cursors_throw_a_plain_invalid_cursor", () => {
    expect(() => decodePartyCursor("!!!!", { query: "*", open: undefined, limit: 2 })).toThrow(
      "invalid cursor",
    );
    expect(() => decodePartyCursor(btoa("[1,2]"), { query: "*", open: undefined, limit: 2 })).toThrow(
      "invalid cursor",
    );
    // 负偏移量不是合法游标。
    expect(() =>
      decodePartyCursor(encodePartyCursor({ query: "*", open: true, offset: -1, limit: 2 }), {
        query: "*",
        open: true,
        limit: 2,
      }),
    ).toThrow("invalid cursor");
  });

  it("test_zero_limit_short_circuits", () => {
    expect(listParties([record(U1, 1)], filters({ limit: 0 }))).toEqual({ parties: [], cursor: "" });
  });
});
