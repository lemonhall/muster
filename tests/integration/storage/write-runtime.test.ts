/**
 * M2 / REQ-0001-006：存储写入（运行时路径）
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
  READ_PUBLIC,
  STORAGE_TENANT,
  WRITE_REJECTED_VERSION,
  attemptWrite,
  expectedVersion,
  generateString,
  insertUser,
  newUserId,
  op,
  read,
  storageEnv,
} from "../../helpers/storage-domain";

describe("M2 契约: 存储写入（运行时路径）", () => {
  it("test_storage_write_runtime_global_single", async () => {
    // 溯源: server/core_storage_test.go::TestStorageWriteRuntimeGlobalSingle
    const env = storageEnv();
    const key = generateString();
    const ops = [
      op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: READ_PUBLIC, write: 1 }),
    ];

    const written = await attemptWrite(env, NIL_USER_ID, ops, true);
    expect(written.error).toBeNull();
    expect(written.code).toBe(Code.OK);
    expect(written.value).toHaveLength(1);
    expect(written.value?.[0]?.collection).toBe("testcollection");
    expect(written.value?.[0]?.key).toBe(key);
    expect(written.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    const objects = await read(env, NIL_USER_ID, [{ collection: "testcollection", key, userId: "" }]);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.collection).toBe(written.value?.[0]?.collection);
    expect(objects[0]?.key).toBe(key);
    expect(objects[0]?.userId).toBe(NIL_USER_ID);
    expect(objects[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));
    expect(objects[0]?.permissionRead).toBe(READ_PUBLIC);
    expect(objects[0]?.permissionWrite).toBe(1);
  });

  it("test_storage_write_runtime_user_multiple", async () => {
    // 溯源: server/core_storage_test.go::TestStorageWriteRuntimeUserMultiple
    const env = storageEnv();
    const owners = [newUserId(), newUserId(), newUserId()];
    for (const owner of owners) await insertUser(STORAGE_TENANT, owner);

    const values = ['{"foo":"bar"}', '{"foo":"baz"}', '{"foo":"qux"}'];
    const ops = [
      op({ collection: "testcollection", key: generateString(), value: values[0] as string, read: 2, write: 1 }),
      op({ collection: "testcollection", key: generateString(), value: values[1] as string, read: 0, write: 0 }),
      op({ collection: "testcollection", key: generateString(), value: values[2] as string, read: 1, write: 1 }),
    ];

    const written = await attemptWrite(env, owners[0] as string, ops, false);
    expect(written.error).toBeNull();
    expect(written.code).toBe(Code.OK);
    expect(written.value).toHaveLength(3);
    for (const [index, ack] of (written.value ?? []).entries()) {
      expect(ack.collection).toBe(ops[index]?.collection);
      expect(ack.key).toBe(ops[index]?.key);
      expect(ack.version).toBe(expectedVersion(values[index] as string));
    }
  });

  it("test_storage_write_runtime_global_single_if_match_not_exists", async () => {
    // 溯源: server/core_storage_test.go::TestStorageWriteRuntimeGlobalSingleIfMatchNotExists
    const env = storageEnv();
    const result = await attemptWrite(
      env,
      NIL_USER_ID,
      [op({ collection: "testcollection", key: generateString(), value: '{"foo":"bar"}', version: "fail", read: 2, write: 1 })],
      true,
    );

    expect(result.value).toBeNull();
    expect(result.code).toBe(Code.FailedPrecondition);
    expect(result.error).toBe(WRITE_REJECTED_VERSION);
  });

  it("test_storage_write_runtime_global_single_if_match_exists", async () => {
    // 溯源: server/core_storage_test.go::TestStorageWriteRuntimeGlobalSingleIfMatchExists
    const env = storageEnv();
    const key = generateString();

    const first = await attemptWrite(
      env,
      NIL_USER_ID,
      [op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 2, write: 1 })],
      true,
    );
    expect(first.error).toBeNull();
    expect(first.code).toBe(Code.OK);
    expect(first.value).toHaveLength(1);
    expect(first.value?.[0]?.userId).toBe(NIL_USER_ID);
    expect(first.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    const second = await attemptWrite(
      env,
      NIL_USER_ID,
      [
        op({
          collection: "testcollection",
          key,
          value: '{"foo":"baz"}',
          version: first.value?.[0]?.version,
          read: 2,
          write: 1,
        }),
      ],
      true,
    );

    expect(second.error).toBeNull();
    expect(second.code).toBe(Code.OK);
    expect(second.value).toHaveLength(1);
    expect(second.value?.[0]?.key).toBe(key);
    expect(second.value?.[0]?.userId).toBe(NIL_USER_ID);
    expect(second.value?.[0]?.version).toBe(expectedVersion('{"foo":"baz"}'));
  });

  it("test_storage_write_runtime_global_single_if_match_exists_fail", async () => {
    // 溯源: server/core_storage_test.go::TestStorageWriteRuntimeGlobalSingleIfMatchExistsFail
    const env = storageEnv();
    const key = generateString();

    const first = await attemptWrite(
      env,
      NIL_USER_ID,
      [op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 2, write: 1 })],
      true,
    );
    expect(first.code).toBe(Code.OK);
    expect(first.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    const second = await attemptWrite(
      env,
      NIL_USER_ID,
      [
        op({
          collection: "testcollection",
          key,
          value: '{"foo":"baz"}',
          version: "fail",
          read: 2,
          write: 1,
        }),
      ],
      true,
    );

    expect(second.value).toBeNull();
    expect(second.code).toBe(Code.FailedPrecondition);
    expect(second.error).toBe(WRITE_REJECTED_VERSION);
  });

  it("test_storage_write_runtime_global_single_if_none_match_not_exists", async () => {
    // 溯源: server/core_storage_test.go::TestStorageWriteRuntimeGlobalSingleIfNoneMatchNotExists
    const env = storageEnv();
    const key = generateString();
    const result = await attemptWrite(
      env,
      NIL_USER_ID,
      [op({ collection: "testcollection", key, value: '{"foo":"bar"}', version: "*", read: 2, write: 1 })],
      true,
    );

    expect(result.error).toBeNull();
    expect(result.value).toHaveLength(1);
    expect(result.value?.[0]?.collection).toBe("testcollection");
    expect(result.value?.[0]?.key).toBe(key);
    expect(result.value?.[0]?.userId).toBe(NIL_USER_ID);
    expect(result.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));
  });

  it("test_storage_write_runtime_global_single_if_none_match_exists", async () => {
    // 溯源: server/core_storage_test.go::TestStorageWriteRuntimeGlobalSingleIfNoneMatchExists
    const env = storageEnv();
    const key = generateString();

    const first = await attemptWrite(
      env,
      NIL_USER_ID,
      [op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 2, write: 1 })],
      true,
    );
    expect(first.error).toBeNull();
    expect(first.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    const second = await attemptWrite(
      env,
      NIL_USER_ID,
      [op({ collection: "testcollection", key, value: '{"foo":"baz"}', version: "*", read: 2, write: 1 })],
      true,
    );

    expect(second.value).toBeNull();
    expect(second.code).toBe(Code.FailedPrecondition);
    expect(second.error).toBe(WRITE_REJECTED_VERSION);
  });

  it("test_storage_write_runtime_global_multiple_if_match_not_exists", async () => {
    // 溯源: server/core_storage_test.go::TestStorageWriteRuntimeGlobalMultipleIfMatchNotExists
    const env = storageEnv();
    const result = await attemptWrite(
      env,
      NIL_USER_ID,
      [
        op({ collection: "testcollection", key: generateString(), value: '{"foo":"bar"}', read: 2, write: 1 }),
        op({ collection: "testcollection", key: generateString(), value: '{"foo":"baz"}', version: "fail", read: 0, write: 0 }),
      ],
      true,
    );

    expect(result.value).toBeNull();
    expect(result.code).toBe(Code.FailedPrecondition);
    expect(result.error).toBe(WRITE_REJECTED_VERSION);
  });

  it("test_storage_write_runtime_global_multiple_same_key", async () => {
    // 溯源: server/core_storage_test.go::TestStorageWriteRuntimeGlobalMultipleSameKey
    const env = storageEnv();
    const key = generateString();
    const values = ['{"foo":"bar"}', '{"foo":"baz"}', '{"foo":"qux"}'];
    const ops = [
      op({ collection: "testcollection", key, value: values[0] as string, read: 2, write: 1 }),
      op({ collection: "testcollection", key, value: values[1] as string, read: 0, write: 0 }),
      op({ collection: "testcollection", key, value: values[2] as string, read: 1, write: 1 }),
    ];

    const written = await attemptWrite(env, NIL_USER_ID, ops, true);
    expect(written.error).toBeNull();
    expect(written.code).toBe(Code.OK);
    expect(written.value).toHaveLength(3);
    for (const [index, ack] of (written.value ?? []).entries()) {
      expect(ack.collection).toBe(ops[index]?.collection);
      expect(ack.key).toBe(key);
      expect(ack.userId).toBe(NIL_USER_ID);
      expect(ack.version).toBe(expectedVersion(values[index] as string));
    }

    // 批内同一个 key 的多次写按顺序生效，最后一次（qux, read=1, write=1）胜出。
    const objects = await read(env, NIL_USER_ID, [{ collection: "testcollection", key, userId: "" }]);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.collection).toBe("testcollection");
    expect(objects[0]?.key).toBe(key);
    expect(objects[0]?.userId).toBe(NIL_USER_ID);
    expect(objects[0]?.version).toBe(expectedVersion('{"foo":"qux"}'));
    expect(objects[0]?.permissionRead).toBe(1);
    expect(objects[0]?.permissionWrite).toBe(1);
  });
});

