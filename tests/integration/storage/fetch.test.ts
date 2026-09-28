/**
 * M2 / REQ-0001-006：存储读取
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
  NIL_USER_ID,
  STORAGE_TENANT,
  attemptWrite,
  expectedVersion,
  generateString,
  insertUser,
  newUserId,
  op,
  read,
  storageEnv,
} from "../../helpers/storage-domain";

describe("M2 契约: 存储读取", () => {
  it("test_storage_fetch_runtime_global_private", async () => {
    // 溯源: server/core_storage_test.go::TestStorageFetchRuntimeGlobalPrivate
    const env = storageEnv();
    const key = generateString();

    const written = await attemptWrite(
      env,
      NIL_USER_ID,
      [op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 0, write: 0 })],
      true,
    );
    expect(written.error).toBeNull();
    expect(written.code).toBe(Code.OK);
    expect(written.value).toHaveLength(1);
    expect(written.value?.[0]?.collection).toBe("testcollection");
    expect(written.value?.[0]?.key).toBe(key);
    expect(written.value?.[0]?.userId).toBe(NIL_USER_ID);
    expect(written.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    // 运行时读（caller = 全零 UUID）不受读权限限制：read=0 的全局对象也读得到。
    const objects = await read(env, NIL_USER_ID, [{ collection: "testcollection", key, userId: "" }]);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.collection).toBe(written.value?.[0]?.collection);
    expect(objects[0]?.key).toBe(written.value?.[0]?.key);
    expect(objects[0]?.userId).toBe(NIL_USER_ID);
    expect(objects[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));
    expect(objects[0]?.permissionRead).toBe(0);
    expect(objects[0]?.permissionWrite).toBe(0);
  });

  it("test_storage_fetch_runtime_mixed", async () => {
    // 溯源: server/core_storage_test.go::TestStorageFetchRuntimeMixed
    const env = storageEnv();
    const key = generateString();

    const written = await attemptWrite(
      env,
      NIL_USER_ID,
      [op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 0, write: 0 })],
      true,
    );
    expect(written.error).toBeNull();
    expect(written.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    // 命中与未命中混在一起：只有命中的那个回来，未命中不是错误。
    const objects = await read(env, NIL_USER_ID, [
      { collection: "testcollection", key, userId: "" },
      { collection: "testcollection", key: "notfound", userId: "" },
    ]);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.collection).toBe(written.value?.[0]?.collection);
    expect(objects[0]?.key).toBe(written.value?.[0]?.key);
    expect(objects[0]?.userId).toBe(NIL_USER_ID);
    expect(objects[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));
    expect(objects[0]?.permissionRead).toBe(0);
    expect(objects[0]?.permissionWrite).toBe(0);
  });

  it("test_storage_fetch_runtime_user_private", async () => {
    // 溯源: server/core_storage_test.go::TestStorageFetchRuntimeUserPrivate
    const env = storageEnv();
    const key = generateString();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);

    const written = await attemptWrite(
      env,
      uid,
      [op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 0, write: 0 })],
      true,
    );
    expect(written.error).toBeNull();
    expect(written.value?.[0]?.userId).toBe(uid);
    expect(written.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    const objects = await read(env, NIL_USER_ID, [{ collection: "testcollection", key, userId: uid }]);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.collection).toBe(written.value?.[0]?.collection);
    expect(objects[0]?.key).toBe(written.value?.[0]?.key);
    expect(objects[0]?.userId).toBe(uid);
    expect(objects[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));
    expect(objects[0]?.permissionRead).toBe(0);
    expect(objects[0]?.permissionWrite).toBe(0);
  });

  it("test_storage_fetch_pipeline_global_private", async () => {
    // 溯源: server/core_storage_test.go::TestStorageFetchPipelineGlobalPrivate
    const env = storageEnv();
    const key = generateString();

    const written = await attemptWrite(
      env,
      NIL_USER_ID,
      [op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 0, write: 0 })],
      true,
    );
    expect(written.error).toBeNull();
    expect(written.value?.[0]?.userId).toBe(NIL_USER_ID);
    expect(written.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    // 客户端（非全零 caller）读 read=0 的全局对象 → 读不到，但不是错误。
    const objects = await read(env, newUserId(), [
      { collection: "testcollection", key, userId: "" },
    ]);
    expect(objects).toHaveLength(0);
  });

  it("test_storage_fetch_pipeline_user_private", async () => {
    // 溯源: server/core_storage_test.go::TestStorageFetchPipelineUserPrivate
    const env = storageEnv();
    const key = generateString();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);

    const written = await attemptWrite(env, uid, [
      op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 0, write: 0 }),
    ]);
    expect(written.error).toBeNull();
    expect(written.value?.[0]?.userId).toBe(uid);
    expect(written.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    // read=0 连属主自己都读不到（上游 `(read = 2 or (read = 1 and user_id = caller))`）。
    const objects = await read(env, uid, [{ collection: "testcollection", key, userId: uid }]);
    expect(objects).toHaveLength(0);
  });

  it("test_storage_fetch_pipeline_user_read", async () => {
    // 溯源: server/core_storage_test.go::TestStorageFetchPipelineUserRead
    const env = storageEnv();
    const key = generateString();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);

    const written = await attemptWrite(env, uid, [
      op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 1, write: 0 }),
    ]);
    expect(written.error).toBeNull();
    expect(written.value?.[0]?.userId).toBe(uid);
    expect(written.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    const objects = await read(env, uid, [{ collection: "testcollection", key, userId: uid }]);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.collection).toBe(written.value?.[0]?.collection);
    expect(objects[0]?.key).toBe(written.value?.[0]?.key);
    expect(objects[0]?.userId).toBe(uid);
    expect(objects[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));
    expect(objects[0]?.permissionRead).toBe(1);
    expect(objects[0]?.permissionWrite).toBe(0);
  });

  it("test_storage_fetch_pipeline_user_public", async () => {
    // 溯源: server/core_storage_test.go::TestStorageFetchPipelineUserPublic
    const env = storageEnv();
    const key = generateString();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);

    const written = await attemptWrite(env, uid, [
      op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 2, write: 0 }),
    ]);
    expect(written.error).toBeNull();
    expect(written.value?.[0]?.userId).toBe(uid);
    expect(written.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    const objects = await read(env, uid, [{ collection: "testcollection", key, userId: uid }]);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.userId).toBe(uid);
    expect(objects[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));
    expect(objects[0]?.permissionRead).toBe(2);
    expect(objects[0]?.permissionWrite).toBe(0);
  });

  it("test_storage_fetch_pipeline_user_other_read", async () => {
    // 溯源: server/core_storage_test.go::TestStorageFetchPipelineUserOtherRead
    const env = storageEnv();
    const key = generateString();
    const owner = newUserId();
    const other = newUserId();
    await insertUser(STORAGE_TENANT, owner);

    const written = await attemptWrite(env, owner, [
      op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 1, write: 1 }),
    ]);
    expect(written.error).toBeNull();
    expect(written.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    // read=1（owner-only）对另一个用户不可读——这是"owner read"不是"public read"。
    const objects = await read(env, other, [{ collection: "testcollection", key, userId: owner }]);
    expect(objects).toHaveLength(0);
  });

  it("test_storage_fetch_pipeline_user_other_public", async () => {
    // 溯源: server/core_storage_test.go::TestStorageFetchPipelineUserOtherPublic
    const env = storageEnv();
    const key = generateString();
    const owner = newUserId();
    const other = newUserId();
    await insertUser(STORAGE_TENANT, owner);

    const written = await attemptWrite(env, owner, [
      op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 2, write: 1 }),
    ]);
    expect(written.error).toBeNull();
    expect(written.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    const objects = await read(env, other, [{ collection: "testcollection", key, userId: owner }]);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.userId).toBe(owner);
    expect(objects[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));
    expect(objects[0]?.permissionRead).toBe(2);
  });

  it("test_storage_fetch_pipeline_user_other_public_mixed", async () => {
    // 溯源: server/core_storage_test.go::TestStorageFetchPipelineUserOtherPublicMixed
    const env = storageEnv();
    const key1 = generateString();
    const key2 = generateString();
    const owner = newUserId();
    const other = newUserId();
    await insertUser(STORAGE_TENANT, owner);

    const written = await attemptWrite(env, owner, [
      op({ collection: "testcollection", key: key1, value: '{"foo":"bar"}', read: 1, write: 1 }),
      op({ collection: "testcollection", key: key2, value: '{"foo":"baz"}', read: 2, write: 1 }),
    ]);
    expect(written.error).toBeNull();
    expect(written.value).toHaveLength(2);

    // 混着要两个：只有 public read 的那个能拿到。
    const objects = await read(env, other, [
      { collection: "testcollection", key: key1, userId: owner },
      { collection: "testcollection", key: key2, userId: owner },
    ]);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.key).toBe(key2);
    expect(objects[0]?.userId).toBe(owner);
    expect(objects[0]?.version).toBe(expectedVersion('{"foo":"baz"}'));
  });
});

