import { describe, expect, it } from "vitest";

import {
  NIL_USER_ID,
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

/**
 * M2 / REQ-0001-007：存储索引的写入侧语义。
 *
 * 搬运自上游 `server/storage_index_test.go::TestLocalStorageIndex_Write`（4 个 t.Run），
 * 逐个断言"哪些对象会进索引、哪些不会、淘汰什么时候发生"。
 *
 * 与上游的机制差异（ECN-0005）：上游维护内存 bluge 索引、写入时同步喂进去；
 * 我们的索引是对权威表 `storage_objects` 的声明式查询，所以"写入索引"这件事在我们的
 * 用例里不表现为一次调用，而是表现为**查得到 / 查不到**——断言的是同一件可观测事实。
 */
describe("M2 契约: 存储索引写入", () => {
  const collection1 = "test_collection_1";
  const collection2 = "test_collection_2";
  const key = "key";
  const valueOne = jsonValue({ one: 1 });
  const valueTwo = jsonValue({ two: 2 });
  const valueThree = jsonValue({ three: 3 });

  it("test_indexes_storage_objects_matching_configured_index_collection_key_and_fields", async () => {
    // 溯源: server/storage_index_test.go::TestLocalStorageIndex_Write
    // 契约源: server/storage_index.go::LocalStorageIndex.Write
    const env = indexEnv();
    const nilUid = NIL_USER_ID;
    const u1 = newUserId();
    const u2 = newUserId();
    const u3 = newUserId();
    const u4 = newUserId();
    const u5 = newUserId();
    for (const uid of [u1, u2, u3, u4, u5]) await insertUser(env.tenantId, uid);

    const indexName1 = "test_index_1";
    const indexName2 = "test_index_2";
    const maxEntries1 = 10;
    const maxEntries2 = 3;

    await createIndexFor(env, indexName1, collection1, key, ["one", "two"], [], maxEntries1, false);
    // key 为空 = 这个集合里所有 key 都进索引。
    await createIndexFor(env, indexName2, collection1, "", ["three"], [], maxEntries2, false);

    const writes = [
      { owner: nilUid, collection: collection1, key, value: valueOne },
      { owner: u1, collection: collection1, key: "key_no_match", value: valueOne },
      { owner: u2, collection: "collection_no_match", key, value: valueOne },
      { owner: u3, collection: collection2, key, value: valueThree },
      { owner: u4, collection: collection1, key, value: valueTwo },
      { owner: u5, collection: collection1, key: "key2", value: valueThree },
    ];
    for (const write of writes) {
      await writeAt(env, write.owner, [
        op({ collection: write.collection, key: write.key, value: write.value }),
      ]);
    }

    const index1 = await readIndex(env, nilUid, indexName1, "", maxEntries1);
    expect(index1.objects).toHaveLength(2);
    expect(index1.objects.map((row) => row.user_id).sort()).toEqual([nilUid, u4].sort());

    const index2 = await readIndex(env, nilUid, indexName2, "", maxEntries1);
    expect(index2.objects).toHaveLength(1);
    expect(index2.objects[0]?.user_id).toBe(u5);

    await teardown(
      env,
      writes.map((write) => ({ ownerId: write.owner, collection: write.collection, key: write.key })),
    );
  });

  it("test_only_indexes_the_values_of_matching_fields", async () => {
    // 溯源: server/storage_index_test.go::TestLocalStorageIndex_Write
    // 契约源: server/storage_index.go::LocalStorageIndex.mapIndexStorageFields
    const env = indexEnv();
    const indexName = "test_index_fields";
    await createIndexFor(env, indexName, collection1, key, ["one", "two"], [], 10, false);

    // 对象里同时有 one 与 three，但索引只吃 one/two —— 所以 three 在索引里不存在。
    const value = jsonValue({ one: 1, three: 3 });
    await writeAt(env, NIL_USER_ID, [op({ collection: collection1, key, value })]);

    const entries = await readIndex(env, NIL_USER_ID, indexName, "+value.three:3", 10);
    expect(entries.objects).toHaveLength(0);

    // 反向对照：被索引的字段查得到。
    const hit = await readIndex(env, NIL_USER_ID, indexName, "+value.one:1", 10);
    expect(hit.objects).toHaveLength(1);

    await teardown(env, [{ ownerId: NIL_USER_ID, collection: collection1, key }]);
  });

  it("test_allows_concurrent_writes_to_index", async () => {
    // 溯源: server/storage_index_test.go::TestLocalStorageIndex_Write
    const env = indexEnv();
    const indexName = "test_index_concurrent";
    await createIndexFor(env, indexName, collection1, key, ["one"], [], 10, false);

    // 上游这里用两个 goroutine 各写 1000 次**同一个对象**（Key 必须等于索引配置的 key，
    // 否则 `idx.Key == so.Key` 不成立、根本进不了索引），断言是 assert.NotPanicsf。
    // 我们的索引是对权威表的声明式查询，没有共享可变索引，但仍要证明同一件事：
    // 并发写 + 并发读不报错，且同一 (collection, key, user) 反复写只留一条。
    // 轮数 1000 → 20 见 ECN-0005：本地 workerd + D1 每轮都是真实事务，
    // 加轮数只拖长用例、不增加可观测结论。
    const rounds = 20;
    const worker = async (): Promise<void> => {
      for (let index = 0; index < rounds; index += 1) {
        await writeAt(env, NIL_USER_ID, [
          op({ collection: collection1, key, value: valueOne }),
        ]);
        await readIndex(env, NIL_USER_ID, indexName, "", 10);
      }
    };
    await expect(Promise.all([worker(), worker()])).resolves.toBeDefined();

    const entries = await readIndex(env, NIL_USER_ID, indexName, "", 10);
    expect(entries.objects).toHaveLength(1);
    expect(entries.objects[0]?.key).toBe(key);

    await teardown(env, [{ ownerId: NIL_USER_ID, collection: collection1, key }]);
  });

  it("test_evicts_oldest_entries_after_indexed_count_is_10_percent_above_max_entries", async () => {
    // 溯源: server/storage_index_test.go::TestLocalStorageIndex_Write
    // 契约源: server/storage_index.go::LocalStorageIndex.List
    const env = indexEnv();
    const maxEntries2 = 3;
    const indexName2 = "test_index_evict";
    await createIndexFor(env, indexName2, collection1, "", ["three"], [], maxEntries2, false);

    const u1 = newUserId();
    const u2 = newUserId();
    const u3 = newUserId();
    for (const uid of [u1, u2, u3]) await insertUser(env.tenantId, uid);

    const writes = [
      { owner: NIL_USER_ID, key },
      { owner: u1, key: collection1 },
      { owner: u2, key },
      { owner: u3, key },
    ];
    for (const write of writes) {
      await writeAt(env, write.owner, [
        op({ collection: collection1, key: write.key, value: valueThree }),
      ]);
    }

    // 4 条 > max_entries(3) * 1.1 = 3 → 只保留最新 3 条：最早写的那条（nil user）被淘汰。
    const entries = await readIndex(env, NIL_USER_ID, indexName2, "", maxEntries2);
    expect(entries.objects).toHaveLength(3);
    for (const entry of entries.objects) {
      expect(entry.user_id).not.toBe(NIL_USER_ID);
    }

    await teardown(
      env,
      writes.map((write) => ({ ownerId: write.owner, collection: collection1, key: write.key })),
    );
  });
});
