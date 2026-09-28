/**
 * M2 / REQ-0001-006：存储删除
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
  DELETE_REJECTED,
  NIL_USER_ID,
  STORAGE_TENANT,
  attemptDelete,
  attemptWrite,
  expectedVersion,
  generateString,
  insertUser,
  newUserId,
  op,
  read,
  storageEnv,
} from "../../helpers/storage-domain";

describe("M2 契约: 存储删除", () => {
  it("test_storage_remove_runtime_global_public", async () => {
    // 溯源: server/core_storage_test.go::TestStorageRemoveRuntimeGlobalPublic
    const env = storageEnv();
    const key = generateString();

    const written = await attemptWrite(
      env,
      NIL_USER_ID,
      [op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 1, write: 1 })],
      true,
    );
    expect(written.error).toBeNull();
    expect(written.value?.[0]?.userId).toBe(NIL_USER_ID);
    expect(written.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    const removed = await attemptDelete(
      env,
      NIL_USER_ID,
      [{ collection: "testcollection", key, version: "" }],
      true,
    );
    expect(removed.error).toBeNull();
    expect(removed.code).toBe(Code.OK);
  });

  it("test_storage_remove_runtime_global_private", async () => {
    // 溯源: server/core_storage_test.go::TestStorageRemoveRuntimeGlobalPrivate
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

    const removed = await attemptDelete(
      env,
      NIL_USER_ID,
      [{ collection: "testcollection", key, version: "" }],
      true,
    );
    expect(removed.error).toBeNull();
  });

  it("test_storage_remove_runtime_user_public", async () => {
    // 溯源: server/core_storage_test.go::TestStorageRemoveRuntimeUserPublic
    const env = storageEnv();
    const key = generateString();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);

    const written = await attemptWrite(
      env,
      uid,
      [op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 1, write: 1 })],
      true,
    );
    expect(written.error).toBeNull();
    expect(written.value?.[0]?.userId).toBe(uid);
    expect(written.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    const removed = await attemptDelete(
      env,
      uid,
      [{ collection: "testcollection", key, version: "" }],
      true,
    );
    expect(removed.error).toBeNull();
  });

  it("test_storage_remove_runtime_user_private", async () => {
    // 溯源: server/core_storage_test.go::TestStorageRemoveRuntimeUserPrivate
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

    const removed = await attemptDelete(
      env,
      uid,
      [{ collection: "testcollection", key, version: "" }],
      true,
    );
    expect(removed.error).toBeNull();

    const objects = await read(env, NIL_USER_ID, [{ collection: "testcollection", key, userId: uid }]);
    expect(objects).toHaveLength(0);
  });

  it("test_storage_remove_pipeline_user_write", async () => {
    // 溯源: server/core_storage_test.go::TestStorageRemovePipelineUserWrite
    const env = storageEnv();
    const key = generateString();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);

    const written = await attemptWrite(env, uid, [
      op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 1, write: 1 }),
    ]);
    expect(written.error).toBeNull();
    expect(written.value?.[0]?.userId).toBe(uid);
    expect(written.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    const removed = await attemptDelete(
      env,
      uid,
      [{ collection: "testcollection", key, version: "" }],
      true,
    );
    expect(removed.error).toBeNull();
  });

  it("test_storage_remove_pipeline_user_denied", async () => {
    // 溯源: server/core_storage_test.go::TestStorageRemovePipelineUserDenied
    const env = storageEnv();
    const key = generateString();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);

    // 建一个 write=0 的对象：客户端写入"新建"不检查新对象的写位，所以这次能建出来。
    const written = await attemptWrite(env, uid, [
      op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 1, write: 0 }),
    ]);
    expect(written.error).toBeNull();
    expect(written.value?.[0]?.userId).toBe(uid);
    expect(written.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    // 但客户端再删就被 write>0 挡住。
    const removed = await attemptDelete(env, uid, [{ collection: "testcollection", key, version: "" }]);
    expect(removed.value).toBeNull();
    expect(removed.code).toBe(Code.InvalidArgument);
    expect(removed.error).toBe(DELETE_REJECTED);
  });

  it("test_storage_remove_runtime_global_if_match_not_exists", async () => {
    // 溯源: server/core_storage_test.go::TestStorageRemoveRuntimeGlobalIfMatchNotExists
    const env = storageEnv();
    const removed = await attemptDelete(
      env,
      NIL_USER_ID,
      [{ collection: "testcollection", key: generateString(), version: "fail" }],
      true,
    );

    expect(removed.value).toBeNull();
    expect(removed.code).toBe(Code.InvalidArgument);
    expect(removed.error).toBe(DELETE_REJECTED);
  });

  it("test_storage_remove_runtime_global_if_match_rejected", async () => {
    // 溯源: server/core_storage_test.go::TestStorageRemoveRuntimeGlobalIfMatchRejected
    const env = storageEnv();
    const key = generateString();

    const written = await attemptWrite(
      env,
      NIL_USER_ID,
      [op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 1, write: 1 })],
      true,
    );
    expect(written.error).toBeNull();
    expect(written.value?.[0]?.userId).toBe(NIL_USER_ID);
    expect(written.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    const removed = await attemptDelete(
      env,
      NIL_USER_ID,
      [{ collection: "testcollection", key, version: "fail" }],
      true,
    );

    expect(removed.value).toBeNull();
    expect(removed.code).toBe(Code.InvalidArgument);
    expect(removed.error).toBe(DELETE_REJECTED);
  });

  it("test_storage_remove_runtime_global_if_match", async () => {
    // 溯源: server/core_storage_test.go::TestStorageRemoveRuntimeGlobalIfMatch
    const env = storageEnv();
    const key = generateString();

    const written = await attemptWrite(
      env,
      NIL_USER_ID,
      [op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 1, write: 1 })],
      true,
    );
    expect(written.error).toBeNull();
    expect(written.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    const removed = await attemptDelete(
      env,
      NIL_USER_ID,
      [{ collection: "testcollection", key, version: written.value?.[0]?.version ?? "" }],
      true,
    );
    expect(removed.error).toBeNull();

    const objects = await read(env, NIL_USER_ID, [{ collection: "testcollection", key, userId: "" }]);
    expect(objects).toHaveLength(0);
  });
});

