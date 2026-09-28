/**
 * M2 / REQ-0001-006：多参数读取
 *
 * 搬运自上游 `server/core_storage_test.go`，用例上方的 `溯源:` 注释是覆盖矩阵脚本判定 `ported` 的依据；
 * 每条的期望值都来自上游源码，不是“看起来应该”。
 *
 * 公共工装见 `tests/helpers/storage-domain.ts`；测试只跑本地 workerd + 本地 D1，
 * 不碰任何 Cloudflare 远端资源。
 */

import { describe, expect, it } from "vitest";

import {
  Code,
  STORAGE_TENANT,
  attemptWrite,
  generateString,
  insertUser,
  newUserId,
  op,
  read,
  storageEnv,
} from "../../helpers/storage-domain";

describe("M2 契约: 多参数读取", () => {
  it("test_storage_read_objects_same_args", async () => {
    // 溯源: server/core_storage_test.go::TestStorageReadObjectsSameArgs
    const env = storageEnv();
    const key = generateString();
    const uid = newUserId();
    const value = '{"foo": "bar"}';
    await insertUser(STORAGE_TENANT, uid);

    const written = await attemptWrite(env, uid, [
      op({ collection: "testcollection1", key, value, read: 2, write: 1 }),
      op({ collection: "testcollection2", key, value, read: 1, write: 1 }),
    ]);
    expect(written.error).toBeNull();
    expect(written.code).toBe(Code.OK);

    const first = await read(env, uid, [
      { collection: "testcollection1", key, userId: uid },
      { collection: "testcollection1", key, userId: uid },
    ]);
    expect(first).toHaveLength(1);
    expect(first[0]?.collection).toBe("testcollection1");
    expect(first[0]?.key).toBe(key);
    expect(first[0]?.userId).toBe(uid);
    expect(first[0]?.value).toBe(value);

    const second = await read(env, uid, [
      { collection: "testcollection2", key, userId: uid },
      { collection: "testcollection2", key, userId: uid },
    ]);
    expect(second).toHaveLength(1);
    expect(second[0]?.collection).toBe("testcollection2");
    expect(second[0]?.key).toBe(key);
    expect(second[0]?.userId).toBe(uid);
    expect(second[0]?.value).toBe(value);
  });

  it("test_storage_read_objects_one_distinct_arg", async () => {
    // 溯源: server/core_storage_test.go::TestStorageReadObjectsOneDistinctArg
    const env = storageEnv();
    const key1 = generateString();
    const key2 = generateString();
    const uid1 = newUserId();
    const uid2 = newUserId();
    const value = '{"foo": "bar"}';
    await insertUser(STORAGE_TENANT, uid1);
    await insertUser(STORAGE_TENANT, uid2);

    const written = await attemptWrite(env, uid1, [
      op({ collection: "testcollection1", key: key1, value, read: 2, write: 1 }),
      op({ collection: "testcollection1", key: key2, value, read: 2, write: 1 }),
      op({ collection: "testcollection2", key: key1, value, read: 2, write: 1 }),
    ]);
    expect(written.error).toBeNull();
    const asUid2 = await attemptWrite(env, uid2, [
      op({ collection: "testcollection1", key: key1, value, read: 2, write: 1 }),
    ]);
    expect(asUid2.error).toBeNull();

    // 集合不同、key 与 owner 相同。
    const crossCollection = await read(env, uid1, [
      { collection: "testcollection1", key: key1, userId: uid1 },
      { collection: "testcollection2", key: key1, userId: uid1 },
    ]);
    expect(crossCollection).toHaveLength(2);
    expect(crossCollection.map((row) => row.collection).sort()).toEqual([
      "testcollection1",
      "testcollection2",
    ]);
    expect(crossCollection.map((row) => row.key)).toEqual([key1, key1]);
    expect(crossCollection.map((row) => row.userId)).toEqual([uid1, uid1]);

    // key 不同、集合与 owner 相同。
    const crossKey = await read(env, uid1, [
      { collection: "testcollection1", key: key1, userId: uid1 },
      { collection: "testcollection1", key: key2, userId: uid1 },
    ]);
    expect(crossKey).toHaveLength(2);
    expect(crossKey.map((row) => row.collection)).toEqual(["testcollection1", "testcollection1"]);
    expect(crossKey.map((row) => row.key).sort()).toEqual([key1, key2].sort());
    expect(crossKey.map((row) => row.userId)).toEqual([uid1, uid1]);

    // owner 不同、集合与 key 相同。
    const crossOwner = await read(env, uid1, [
      { collection: "testcollection1", key: key1, userId: uid1 },
      { collection: "testcollection1", key: key1, userId: uid2 },
    ]);
    expect(crossOwner).toHaveLength(2);
    expect(crossOwner.map((row) => row.collection)).toEqual([
      "testcollection1",
      "testcollection1",
    ]);
    expect(crossOwner.map((row) => row.key)).toEqual([key1, key1]);
    expect(crossOwner.map((row) => row.userId).sort()).toEqual([uid1, uid2].sort());
  });

  it("test_storage_read_objects_two_distinct_args", async () => {
    // 溯源: server/core_storage_test.go::TestStorageReadObjectsTwoDistinctArgs
    const env = storageEnv();
    const key1 = generateString();
    const key2 = generateString();
    const uid1 = newUserId();
    const uid2 = newUserId();
    const value = '{"foo": "bar"}';
    await insertUser(STORAGE_TENANT, uid1);
    await insertUser(STORAGE_TENANT, uid2);

    const written = await attemptWrite(env, uid1, [
      op({ collection: "testcollection1", key: key1, value, read: 2, write: 1 }),
      op({ collection: "testcollection2", key: key2, value, read: 2, write: 1 }),
    ]);
    expect(written.error).toBeNull();
    const asUid2 = await attemptWrite(env, uid2, [
      op({ collection: "testcollection1", key: key2, value, read: 2, write: 1 }),
      op({ collection: "testcollection2", key: key1, value, read: 2, write: 1 }),
    ]);
    expect(asUid2.error).toBeNull();

    const crossCollection = await read(env, uid1, [
      { collection: "testcollection1", key: key1, userId: uid1 },
      { collection: "testcollection2", key: key2, userId: uid1 },
    ]);
    expect(crossCollection).toHaveLength(2);
    expect(crossCollection.map((row) => row.collection).sort()).toEqual([
      "testcollection1",
      "testcollection2",
    ]);
    expect(crossCollection.map((row) => row.key).sort()).toEqual([key1, key2].sort());
    expect(crossCollection.map((row) => row.userId)).toEqual([uid1, uid1]);

    const crossOwner = await read(env, uid1, [
      { collection: "testcollection1", key: key1, userId: uid1 },
      { collection: "testcollection1", key: key2, userId: uid2 },
    ]);
    expect(crossOwner).toHaveLength(2);
    expect(crossOwner.map((row) => row.collection)).toEqual([
      "testcollection1",
      "testcollection1",
    ]);
    expect(crossOwner.map((row) => row.key).sort()).toEqual([key1, key2].sort());
    expect(crossOwner.map((row) => row.userId).sort()).toEqual([uid1, uid2].sort());

    const crossKey = await read(env, uid1, [
      { collection: "testcollection1", key: key1, userId: uid1 },
      { collection: "testcollection2", key: key1, userId: uid2 },
    ]);
    expect(crossKey).toHaveLength(2);
    expect(crossKey.map((row) => row.collection).sort()).toEqual([
      "testcollection1",
      "testcollection2",
    ]);
    expect(crossKey.map((row) => row.key)).toEqual([key1, key1]);
    expect(crossKey.map((row) => row.userId).sort()).toEqual([uid1, uid2].sort());
  });

  it("test_storage_read_objects_all_distinct_args", async () => {
    // 溯源: server/core_storage_test.go::TestStorageReadObjectsAllDistinctArgs
    const env = storageEnv();
    const key1 = generateString();
    const key2 = generateString();
    const uid1 = newUserId();
    const uid2 = newUserId();
    const value = '{"foo": "bar"}';
    await insertUser(STORAGE_TENANT, uid1);
    await insertUser(STORAGE_TENANT, uid2);

    const written = await attemptWrite(env, uid1, [
      op({ collection: "testcollection1", key: key1, value, read: 2, write: 1 }),
    ]);
    expect(written.error).toBeNull();
    const asUid2 = await attemptWrite(env, uid2, [
      op({ collection: "testcollection2", key: key2, value, read: 2, write: 1 }),
    ]);
    expect(asUid2.error).toBeNull();

    const objects = await read(env, uid1, [
      { collection: "testcollection1", key: key1, userId: uid1 },
      { collection: "testcollection2", key: key2, userId: uid2 },
    ]);
    expect(objects).toHaveLength(2);
    expect(objects.map((row) => row.collection).sort()).toEqual([
      "testcollection1",
      "testcollection2",
    ]);
    expect(objects.map((row) => row.key).sort()).toEqual([key1, key2].sort());
    expect(objects.map((row) => row.userId).sort()).toEqual([uid1, uid2].sort());
  });
});

