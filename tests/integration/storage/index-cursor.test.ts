import { describe, expect, it } from "vitest";

import {
  NIL_USER_ID,
  createIndex,
  createIndexFor,
  indexEnv,
  insertUser,
  jsonValue,
  newUserId,
  op,
  readIndex,
  teardown,
  writeAt,
} from "../../helpers/storage-index";
import { attempt } from "../../helpers/storage-domain";
import { decodeIndexCursor, encodeIndexCursor } from "../../../src/domain/storage/index";

/**
 * M2 / REQ-0001-007：索引的校验与边界分支。
 *
 * 上游 `storage_index_test.go` 只走 happy path，这些分支的契约直接从
 * `server/storage_index.go` 的代码立起来（消息逐字照抄，因为客户端会按消息分支）：
 * 游标解不开 / 四元组不符 → `invalid`；索引不存在 → `not found`；建索引的四条校验消息
 * 与重复名的 `already exists`；未声明 sortable 的排序、未声明的查询语法 → `invalid`。
 */
describe("M2 契约: 存储索引游标与校验", () => {
  const key = "key";
  const maxEntries = 10;
  const fields = ["one", "two", "three"];

  it("decodes only well-formed cursors", () => {
    // 非 base64url 字符 → 解码失败。
    expect(() => decodeIndexCursor("!!!not-base64!!!")).toThrowError(
      "invalid cursor: illegal base64 data",
    );
    // 合法 base64url、但不是 JSON（btoa("hello")）。
    expect(() => decodeIndexCursor("aGVsbG8")).toThrowError("invalid cursor: malformed payload");
    // 合法 JSON、但不是四元组对象（btoa("[1,2]")）。
    expect(() => decodeIndexCursor("WzEsMl0")).toThrowError("invalid cursor: malformed payload");

    // 自己编出来的游标必须能被自己解回来——这是分页能往前走的前提。
    const cursor = encodeIndexCursor({ query: "value.one:1", offset: 3, limit: 2, order: ["-value.sort"] });
    expect(cursor).not.toMatch(/[+/=]/u);
    expect(decodeIndexCursor(cursor)).toEqual({
      query: "value.one:1",
      offset: 3,
      limit: 2,
      order: ["-value.sort"],
    });
  });

  it("rejects a cursor whose query, limit or order does not match the request", async () => {
    const env = indexEnv();
    const indexName = "test_index_cursor";
    const collection = "test_collection_cursor";
    const u1 = newUserId();
    await insertUser(env.tenantId, u1);
    await createIndexFor(env, indexName, collection, key, fields, [], maxEntries, true);
    const valueOne = jsonValue({ one: 1 });
    const valueTwo = jsonValue({ two: 2 });
    await writeAt(env, NIL_USER_ID, [op({ collection, key, value: valueOne })]);
    await writeAt(env, u1, [op({ collection, key, value: valueTwo })]);

    const query = "value.one:1 value.two:2";
    const good = { query, offset: 1, limit: 1, order: [] };
    // 先证明这个游标本身是能用的（否则下面的拒绝就说明不了问题）。
    const accepted = await readIndex(
      env,
      NIL_USER_ID,
      indexName,
      query,
      1,
      [],
      encodeIndexCursor(good),
    );
    expect(accepted.objects).toHaveLength(1);

    const mismatch = (cursor: string, limit: number, order: readonly string[]) =>
      readIndex(env, NIL_USER_ID, indexName, query, limit, order, cursor);

    await expect(
      mismatch(encodeIndexCursor({ ...good, query: "value.three:3" }), 1, []),
    ).rejects.toThrowError("invalid cursor: query mismatch");
    await expect(mismatch(encodeIndexCursor({ ...good, limit: 2 }), 1, [])).rejects.toThrowError(
      "invalid cursor: limit mismatch",
    );
    await expect(
      mismatch(encodeIndexCursor({ ...good, order: ["value.one"] }), 1, []),
    ).rejects.toThrowError("invalid cursor: order mismatch");

    await teardown(env, [
      { ownerId: NIL_USER_ID, collection, key },
      { ownerId: u1, collection, key },
    ]);
  });

  it("reports a missing index as not found", async () => {
    const env = indexEnv();
    await expect(readIndex(env, NIL_USER_ID, "test_index_absent", "", 10)).rejects.toThrowError(
      'index "test_index_absent": not found',
    );
  });

  it("validates index declarations with the upstream messages", async () => {
    const env = indexEnv();
    const base = {
      name: "test_index_validate",
      collection: "test_collection_validate",
      key,
      fields,
      sortableFields: [],
      maxEntries,
      indexOnly: false,
    };

    const cases: readonly { readonly patch: Partial<typeof base>; readonly message: string }[] = [
      { patch: { name: "" }, message: "storage index 'name' must be set" },
      { patch: { collection: "" }, message: "storage index 'collection' must be set" },
      { patch: { maxEntries: 0 }, message: "storage Index 'max_entries' must be > 0" },
      {
        patch: { fields: [] },
        message: "storage Index 'fields' must contain at least one top level key to index",
      },
    ];
    for (const item of cases) {
      const outcome = await attempt(() => createIndex(env, { ...base, ...item.patch }));
      expect(outcome.error).toBe(item.message);
    }

    await createIndex(env, base);
    const duplicate = await attempt(() => createIndex(env, base));
    expect(duplicate.error).toBe(
      'cannot create index: index with name "test_index_validate" already exists',
    );
  });

  it("rejects unsupported syntax and undeclared sortable fields", async () => {
    const env = indexEnv();
    const indexName = "test_index_syntax";
    const collection = "test_collection_syntax";
    await createIndexFor(env, indexName, collection, key, fields, [], maxEntries, true);
    const valueOne = jsonValue({ one: 1 });
    await writeAt(env, NIL_USER_ID, [op({ collection, key, value: valueOne })]);

    await expect(readIndex(env, NIL_USER_ID, indexName, "-value.one:1", 10)).rejects.toThrowError(
      "failed to parse query string: negation is not supported: invalid",
    );
    await expect(readIndex(env, NIL_USER_ID, indexName, "one:1", 10)).rejects.toThrowError(
      'failed to parse query string: unsupported clause "one:1": invalid',
    );
    await expect(
      readIndex(env, NIL_USER_ID, indexName, "value.one:1", 10, ["value.one"]),
    ).rejects.toThrowError("failed to sort by field value.one: invalid");

    // 未写进 fields 的字段在索引里不存在 → 恒不匹配（不是报错，也不是"忽略这个子句"）。
    const unindexed = await readIndex(env, NIL_USER_ID, indexName, "value.nope:1", 10);
    expect(unindexed.objects).toHaveLength(0);

    await teardown(env, [{ ownerId: NIL_USER_ID, collection, key }]);
  });
});
