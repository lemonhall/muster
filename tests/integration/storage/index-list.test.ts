import { describe, expect, it } from "vitest";

import {
  NIL_USER_ID,
  createIndexFor,
  deleteAt,
  indexEnv,
  insertUser,
  jsonValue,
  newUserId,
  op,
  readIndex,
  teardown,
  writeAt,
} from "../../helpers/storage-index";
import {
  READ_PRIVATE,
  READ_OWNER,
  READ_PUBLIC,
  type StorageObjectRow,
} from "../../helpers/storage-domain";

/**
 * M2 / REQ-0001-007：存储索引的查询侧语义。
 *
 * 搬运自上游 `server/storage_index_test.go::TestLocalStorageIndex_List`（4 个 t.Run），
 * 断言的是"哪些行会被查出来、按什么顺序、分页怎么走、index_only 返回什么值"。
 *
 * 与上游的机制差异（ECN-0005）：上游维护内存 bluge 索引，查询打在索引上、`index_only
 * 为假`时才回查权威表；我们的索引是打在权威表 `storage_objects` 上的声明式查询，所以
 * "索引里有什么"永远等于"库里有什么"。由此产生的**唯一**可观测差异是上游那条批内
 * 残留（见 test_overwriting_the_same_object_in_one_batch_leaves_no_stale_entry），
 * ECN-0005 里记了复现证据。
 */
describe("M2 契约: 存储索引查询", () => {
  const key = "key";
  const maxEntries = 10;
  const fields = ["one", "two", "three"];
  const valueOne = jsonValue({ one: 1 });
  const valueTwo = jsonValue({ two: 2 });
  const valueThree = jsonValue({ three: 3 });
  const anyOfThree = "value.one:1 value.two:2 value.three:3";

  function userIds(rows: readonly StorageObjectRow[]): string[] {
    return rows.map((row) => row.user_id);
  }

  it("test_paginates_correctly", async () => {
    // 溯源: server/storage_index_test.go::TestLocalStorageIndex_List
    // 契约源: server/storage_index.go::LocalStorageIndex.List
    const env = indexEnv();
    const u1 = newUserId();
    const u2 = newUserId();
    // 每个用例一个索引名 + 一个集合名：上游每个 t.Run 都开一个新库，我们共用同一个库，
    // 靠这两层命名把用例隔开（否则前一个用例失败留下的行会污染后一个用例）。
    const indexName = "test_index_only";
    const collection = "test_collection_limit";
    await insertUser(env.tenantId, u1);
    await insertUser(env.tenantId, u2);
    await createIndexFor(env, indexName, collection, key, fields, [], maxEntries, true);

    // 上游用 (nil, u1, u1) 三个对象，其中 u1 那两条落在同一个主键上，靠 bluge 的批内
    // 残留凑出三页（ECN-0005 §偏差 1）。这里改成三个**互不相同**的成员，断言的仍然是
    // 同一件事：limit=1 时能稳定翻三页、最后一页游标为空、三页无重复无遗漏。
    const writes = [
      { owner: NIL_USER_ID, value: valueOne },
      { owner: u1, value: valueTwo },
      { owner: u2, value: valueThree },
    ];
    for (const write of writes) {
      await writeAt(env, write.owner, [op({ collection, key, value: write.value })]);
    }

    const pages: string[][] = [];
    const cursors: string[] = [];
    let cursor = "";
    for (let page = 0; page < 3; page += 1) {
      const result = await readIndex(env, NIL_USER_ID, indexName, anyOfThree, 1, [], cursor);
      expect(result.objects).toHaveLength(1);
      pages.push(userIds(result.objects));
      cursors.push(result.cursor);
      cursor = result.cursor;
    }

    expect(cursors[0]).not.toBe("");
    expect(cursors[1]).not.toBe("");
    expect(cursors[2]).toBe("");
    const seen = pages.flat();
    expect(new Set(seen).size).toBe(3);
    expect(new Set(seen)).toEqual(new Set([NIL_USER_ID, u1, u2]));

    await teardown(
      env,
      writes.map((write) => ({ ownerId: write.owner, collection, key })),
    );
  });

  it("test_overwriting_the_same_object_in_one_batch_leaves_no_stale_entry", async () => {
    // 溯源: server/storage_index_test.go::TestLocalStorageIndex_List
    // **刻意与上游不同**：ECN-0005 §偏差 1。
    //
    // 上游把三条写入塞进同一个 bluge batch，而 `batch.Update(docID, doc)` 的删除只作用于
    // **批量开始前**已存在的文档：批内后写的同 id 文档不会顶掉先写的那条，于是 u1 在索引里
    // 留下两条（value two、value three），其中 value two 在权威表里已被覆盖、不复存在。
    // 已复现：bluge v0.2.2 内存索引，同一 batch 内三次 Update（后两次同 id）→ `Reader.Count()`
    // = 3；同样的两次 Update 拆成两个 batch → 1。
    //
    // 我们的索引不在库里"留副本"，所以覆盖后只剩 2 条。这不是打折：上游非 index_only 路径
    // 也会把这条陈旧文档按"版本不符"丢掉，所以只有它的 index_only 路径会返回一条权威表里
    // 已经不存在、且客户端无权知道其存在过的值。
    const env = indexEnv();
    const u1 = newUserId();
    const indexName = "test_index_stale";
    const collection = "test_collection_stale";
    await insertUser(env.tenantId, u1);
    await createIndexFor(env, indexName, collection, key, fields, [], maxEntries, true);

    await writeAt(env, NIL_USER_ID, [op({ collection, key, value: valueOne })]);
    // 同一个 batch 里两次写同一个 (collection, key, owner)。
    await writeAt(env, u1, [
      op({ collection, key, value: valueTwo }),
      op({ collection, key, value: valueThree }),
    ]);

    const result = await readIndex(env, NIL_USER_ID, indexName, anyOfThree, 10);
    expect(userIds(result.objects)).toHaveLength(2);
    expect(result.objects.map((row) => row.value).sort()).toEqual([valueOne, valueThree].sort());

    await teardown(env, [
      { ownerId: NIL_USER_ID, collection, key },
      { ownerId: u1, collection, key },
    ]);
  });

  it("test_only_returns_values_the_user_has_permissions_to_see_if_not_the_nil_user", async () => {
    // 溯源: server/storage_index_test.go::TestLocalStorageIndex_List
    const env = indexEnv();
    const u1 = newUserId();
    const u2 = newUserId();
    const indexName = "test_index_active";
    const collection = "test_collection_active";
    await insertUser(env.tenantId, u1);
    await insertUser(env.tenantId, u2);
    const activeOnly = ["active"];
    await createIndexFor(env, indexName, collection, key, activeOnly, [], maxEntries, false);

    const active = jsonValue({ active: true });
    // 四条写入里，u2 的两条落在同一个主键上（上游也是这么写的）：read 位从 1 变到 2。
    const writes = [
      { owner: u1, read: READ_OWNER },
      { owner: NIL_USER_ID, read: READ_PRIVATE },
      { owner: u2, read: READ_OWNER },
      { owner: u2, read: READ_PUBLIC },
    ];
    for (const write of writes) {
      await writeAt(env, write.owner, [
        op({ collection, key, value: active, read: write.read }),
      ]);
    }

    // caller=u1：自己的 owner-only 对象 + u2 的 public 对象；nil user 的 read=0 不可见。
    const result = await readIndex(env, u1, indexName, "value.active:T", maxEntries);
    expect(userIds(result.objects).sort()).toEqual([u1, u2].sort());
    expect(result.cursor).toBe("");

    await teardown(env, [
      { ownerId: u1, collection, key },
      { ownerId: NIL_USER_ID, collection, key },
      { ownerId: u2, collection, key },
    ]);
  });

  it("test_when_index_only_is_false_returns_all_matching_results_for_query_from_the_db", async () => {
    // 溯源: server/storage_index_test.go::TestLocalStorageIndex_List
    // 上游这条用例靠 `DisableIndexOnly` 配置把 index_only 索引退化成回查权威表；本项目没有
    // 这个开关，等价写法是索引声明本身就 `indexOnly = false`——两条路径的断言完全一致。
    const env = indexEnv();
    const u1 = newUserId();
    const indexName = "test_index_plain";
    const collection = "test_collection_plain";
    await insertUser(env.tenantId, u1);
    await createIndexFor(env, indexName, collection, key, fields, [], maxEntries, false);

    await writeAt(env, NIL_USER_ID, [op({ collection, key, value: valueOne })]);
    await writeAt(env, u1, [
      op({ collection, key, value: valueTwo }),
      op({ collection, key, value: valueThree }),
    ]);

    const result = await readIndex(env, NIL_USER_ID, indexName, "value.one:1 value.three:3", 10);
    expect(result.objects.map((row) => row.value)).toEqual([valueOne, valueThree]);

    await teardown(env, [
      { ownerId: NIL_USER_ID, collection, key },
      { ownerId: u1, collection, key },
    ]);
  });

  it("test_when_index_only_is_true_returns_all_matching_results_from_the_index", async () => {
    // 溯源: server/storage_index_test.go::TestLocalStorageIndex_List
    const env = indexEnv();
    const u1 = newUserId();
    const indexName = "test_index_projected";
    const collection = "test_collection_projected";
    await insertUser(env.tenantId, u1);
    const sortableFields = ["sort"];
    const sortFields = ["one", "two", "three", "sort"];
    await createIndexFor(env, indexName, collection, key, sortFields, sortableFields, maxEntries, true);

    const one = jsonValue({ one: 1, sort: 1 });
    const two = jsonValue({ two: 2, sort: 2 });
    const three = jsonValue({ three: 3, sort: 3 });
    await writeAt(env, NIL_USER_ID, [op({ collection, key, value: one })]);
    await writeAt(env, u1, [
      op({ collection, key, value: two }),
      op({ collection, key, value: three }),
    ]);

    // index_only：返回的是**投影后**的 JSON（只含声明里的字段，键名升序），本用例里恰好
    // 与原值同形。被覆盖掉的 value two 不会出现（ECN-0005 §偏差 1）。
    const plain = await readIndex(env, NIL_USER_ID, indexName, "value.one:1 value.three:3", 10);
    expect(plain.objects.map((row) => row.value)).toEqual([one, three]);

    const ascending = await readIndex(env, NIL_USER_ID, indexName, "value.one:1 value.three:3", 10, [
      "value.sort",
    ]);
    expect(ascending.objects.map((row) => row.value)).toEqual([one, three]);

    const descending = await readIndex(env, NIL_USER_ID, indexName, "value.one:1 value.three:3", 10, [
      "-value.sort",
    ]);
    expect(descending.objects.map((row) => row.value)).toEqual([three, one]);

    await teardown(env, [
      { ownerId: NIL_USER_ID, collection, key },
      { ownerId: u1, collection, key },
    ]);
  });

  it("test_delete_removes_matching_entries", async () => {
    // 溯源: server/storage_index_test.go::TestLocalStorageIndex_Delete
    const env = indexEnv();
    const u1 = newUserId();
    const indexName = "test_index_delete";
    const collection = "test_collection_delete";
    await insertUser(env.tenantId, u1);
    // 空 key = 该集合下所有 key 都进索引。
    await createIndexFor(env, indexName, collection, "", ["one"], [], maxEntries, false);

    const valueOneOnly = jsonValue({ one: 1 });
    await writeAt(env, NIL_USER_ID, [op({ collection, key: "key1", value: valueOneOnly })]);
    await writeAt(env, u1, [op({ collection, key: "key2", value: valueOneOnly })]);

    const before = await readIndex(env, NIL_USER_ID, indexName, "", maxEntries);
    expect(before.objects).toHaveLength(2);

    await deleteAt(env, u1, [{ collection, key: "key2", version: "" }]);

    const after = await readIndex(env, NIL_USER_ID, indexName, "", maxEntries);
    expect(after.objects).toHaveLength(1);
    expect(userIds(after.objects)).toEqual([NIL_USER_ID]);

    await teardown(env, [{ ownerId: NIL_USER_ID, collection, key: "key1" }]);
  });
});
