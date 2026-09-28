/**
 * M2 / REQ-0001-006：存储写入（客户端路径）
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
  WRITE_REJECTED_PERMISSION,
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

describe("M2 契约: 存储写入（客户端路径）", () => {
  it("test_storage_write_pipeline_user_single", async () => {
    // 溯源: server/core_storage_test.go::TestStorageWritePipelineUserSingle
    const env = storageEnv();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);

    const key = generateString();
    const result = await attemptWrite(
      env,
      uid,
      [op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 2, write: 1 })],
    );

    expect(result.error).toBeNull();
    expect(result.value).toHaveLength(1);
    expect(result.value?.[0]?.collection).toBe("testcollection");
    expect(result.value?.[0]?.key).toBe(key);
    expect(result.value?.[0]?.userId).toBe(uid);
    expect(result.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));
  });

  it("test_storage_write_pipeline_user_multiple", async () => {
    // 溯源: server/core_storage_test.go::TestStorageWritePipelineUserMultiple
    const env = storageEnv();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);

    const values = ['{"foo":"bar"}', '{"foo":"baz"}', '{"foo":"qux"}'];
    const ops = [
      op({ collection: "testcollection", key: generateString(), value: values[0] as string, read: 2, write: 1 }),
      op({ collection: "testcollection", key: generateString(), value: values[1] as string, read: 0, write: 0 }),
      op({ collection: "testcollection", key: generateString(), value: values[2] as string, read: 1, write: 1 }),
    ];

    const written = await attemptWrite(env, uid, ops);
    expect(written.error).toBeNull();
    expect(written.code).toBe(Code.OK);
    expect(written.value).toHaveLength(3);
    for (const [index, ack] of (written.value ?? []).entries()) {
      expect(ack.collection).toBe(ops[index]?.collection);
      expect(ack.key).toBe(ops[index]?.key);
      expect(ack.userId).toBe(uid);
      expect(ack.version).toBe(expectedVersion(values[index] as string));
    }
  });

  it("test_storage_write_pipeline_user_multiple_same_key", async () => {
    // 溯源: server/core_storage_test.go::TestStorageWritePipelineUserMultipleSameKey
    const env = storageEnv();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);
    const key = generateString();

    const ops = [
      op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 2, write: 1 }),
      op({ collection: "testcollection", key, value: '{"foo":"baz"}', read: 1, write: 0 }),
    ];

    const written = await attemptWrite(env, uid, ops);
    expect(written.error).toBeNull();
    expect(written.code).toBe(Code.OK);
    expect(written.value).toHaveLength(2);
    expect(written.value?.[0]?.userId).toBe(uid);
    expect(written.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));
    expect(written.value?.[1]?.key).toBe(key);
    expect(written.value?.[1]?.userId).toBe(uid);
    expect(written.value?.[1]?.version).toBe(expectedVersion('{"foo":"baz"}'));

    const objects = await read(env, uid, [{ collection: "testcollection", key, userId: uid }]);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.collection).toBe("testcollection");
    expect(objects[0]?.key).toBe(key);
    expect(objects[0]?.userId).toBe(uid);
    expect(objects[0]?.version).toBe(expectedVersion('{"foo":"baz"}'));
    expect(objects[0]?.permissionRead).toBe(1);
    expect(objects[0]?.permissionWrite).toBe(0);
  });

  it("test_storage_write_pipeline_if_match_not_exists", async () => {
    // 溯源: server/core_storage_test.go::TestStorageWritePipelineIfMatchNotExists
    const env = storageEnv();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);

    const result = await attemptWrite(env, uid, [
      op({ collection: "testcollection", key: generateString(), value: '{"foo":"bar"}', version: "fail", read: 2, write: 1 }),
    ]);

    expect(result.value).toBeNull();
    expect(result.code).toBe(Code.FailedPrecondition);
    expect(result.error).toBe(WRITE_REJECTED_VERSION);
  });

  it("test_storage_write_pipeline_if_match_exists_fail", async () => {
    // 溯源: server/core_storage_test.go::TestStorageWritePipelineIfMatchExistsFail
    const env = storageEnv();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);

    const first = await attemptWrite(env, uid, [
      op({ collection: "testcollection", key: generateString(), value: '{"foo":"bar"}', read: 2, write: 1 }),
    ]);
    expect(first.error).toBeNull();
    expect(first.value).toHaveLength(1);
    expect(first.value?.[0]?.userId).toBe(uid);
    expect(first.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    const second = await attemptWrite(env, uid, [
      op({ collection: "testcollection", key: generateString(), value: '{"foo":"baz"}', version: "fail", read: 2, write: 1 }),
    ]);

    expect(second.value).toBeNull();
    expect(second.code).toBe(Code.FailedPrecondition);
    expect(second.error).toBe(WRITE_REJECTED_VERSION);
  });

  it("test_storage_write_pipeline_if_match_exists", async () => {
    // 溯源: server/core_storage_test.go::TestStorageWritePipelineIfMatchExists
    const env = storageEnv();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);
    const key = generateString();

    const first = await attemptWrite(env, uid, [
      op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 2, write: 1 }),
    ]);
    expect(first.value?.[0]?.userId).toBe(uid);
    expect(first.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    const second = await attemptWrite(env, uid, [
      op({
        collection: "testcollection",
        key,
        value: '{"foo":"baz"}',
        version: first.value?.[0]?.version,
        read: 2,
        write: 1,
      }),
    ]);

    expect(second.error).toBeNull();
    expect(second.value?.[0]?.key).toBe(key);
    expect(second.value?.[0]?.userId).toBe(uid);
    expect(second.value?.[0]?.version).toBe(expectedVersion('{"foo":"baz"}'));
  });

  it("test_storage_write_pipeline_if_none_match_not_exists", async () => {
    // 溯源: server/core_storage_test.go::TestStorageWritePipelineIfNoneMatchNotExists
    const env = storageEnv();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);

    const result = await attemptWrite(env, uid, [
      op({ collection: "testcollection", key: generateString(), value: '{"foo":"bar"}', version: "*", read: 2, write: 1 }),
    ]);

    expect(result.error).toBeNull();
    expect(result.value?.[0]?.userId).toBe(uid);
    expect(result.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));
  });

  it("test_storage_write_pipeline_if_none_match_exists", async () => {
    // 溯源: server/core_storage_test.go::TestStorageWritePipelineIfNoneMatchExists
    const env = storageEnv();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);
    const key = generateString();

    const first = await attemptWrite(env, uid, [
      op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 2, write: 1 }),
    ]);
    expect(first.value?.[0]?.userId).toBe(uid);
    expect(first.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    const second = await attemptWrite(env, uid, [
      op({ collection: "testcollection", key, value: '{"foo":"baz"}', version: "*", read: 2, write: 1 }),
    ]);

    expect(second.value).toBeNull();
    expect(second.code).toBe(Code.FailedPrecondition);
    expect(second.error).toBe(WRITE_REJECTED_VERSION);
  });

  it("test_storage_write_pipeline_permission_fail", async () => {
    // 溯源: server/core_storage_test.go::TestStorageWritePipelinePermissionFail
    const env = storageEnv();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);
    const key = generateString();

    const first = await attemptWrite(env, uid, [
      op({ collection: "testcollection", key, value: '{"foo":"bar"}', read: 2, write: 0 }),
    ]);
    expect(first.error).toBeNull();
    expect(first.value?.[0]?.userId).toBe(uid);
    expect(first.value?.[0]?.version).toBe(expectedVersion('{"foo":"bar"}'));

    const second = await attemptWrite(env, uid, [
      op({ collection: "testcollection", key, value: '{"foo":"baz"}', read: 2, write: 1 }),
    ]);

    expect(second.value).toBeNull();
    expect(second.code).toBe(Code.InvalidArgument);
    expect(second.error).toBe(WRITE_REJECTED_PERMISSION);
  });
});

