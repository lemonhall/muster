/**
 * M2 / REQ-0001-006：存储列举
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
  attemptList,
  attemptWrite,
  generateString,
  insertUser,
  newUserId,
  op,
  read,
  storageEnv,
} from "../../helpers/storage-domain";

describe("M2 契约: 存储列举", () => {
  it("test_storage_list_runtime_user", async () => {
    // 溯源: server/core_storage_test.go::TestStorageListRuntimeUser
    const env = storageEnv();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);

    const written = await attemptWrite(env, uid, [
      op({ collection: "testcollection", key: "b", value: "{}", read: 1, write: 1 }),
      op({ collection: "testcollection", key: "a", value: "{}", read: 1, write: 0 }),
      op({ collection: "testcollection", key: "c", value: "{}", read: 0, write: 0 }),
    ]);
    expect(written.error).toBeNull();
    expect(written.value).toHaveLength(3);

    // 运行时列举某个 owner：连 read=0 的也看得到。
    const listed = await attemptList(env, NIL_USER_ID, {
      collection: "testcollection",
      ownerId: uid,
      limit: 10,
      cursor: "",
    });
    expect(listed.error).toBeNull();
    expect(listed.code).toBe(Code.OK);
    expect(listed.value?.objects).toHaveLength(3);
    expect(listed.value?.cursor).toBe("");
  });

  it("test_storage_list_pipeline_user_self", async () => {
    // 溯源: server/core_storage_test.go::TestStorageListPipelineUserSelf
    const env = storageEnv();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);
    const collection = generateString();

    const written = await attemptWrite(env, uid, [
      op({ collection, key: "b", value: "{}", read: 1, write: 1 }),
      op({ collection, key: "a", value: "{}", read: 1, write: 0 }),
      op({ collection, key: "c", value: "{}", read: 0, write: 0 }),
    ]);
    expect(written.error).toBeNull();
    expect(written.value).toHaveLength(3);

    const listed = await attemptList(env, uid, { collection, ownerId: uid, limit: 10, cursor: "" });
    expect(listed.error).toBeNull();
    expect(listed.code).toBe(Code.OK);
    expect(listed.value?.objects).toHaveLength(2);
    // 排序是 read ASC, key ASC——不是按时间，也不是单纯按 key。
    expect(listed.value?.objects[0]?.key).toBe("a");
    expect(listed.value?.objects[1]?.key).toBe("b");
    expect(listed.value?.cursor).toBe("");
  });

  it("test_storage_list_pipeline_user_other", async () => {
    // 溯源: server/core_storage_test.go::TestStorageListPipelineUserOther
    const env = storageEnv();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);
    const collection = generateString();

    const written = await attemptWrite(env, uid, [
      op({ collection, key: "b", value: "{}", read: 1, write: 1 }),
      op({ collection, key: "a", value: "{}", read: 1, write: 0 }),
      op({ collection, key: "c", value: "{}", read: 0, write: 0 }),
    ]);
    expect(written.error).toBeNull();
    expect(written.value).toHaveLength(3);

    // 列别人的数据：只看得到 public read(2)，这里一条都没有。
    const listed = await attemptList(env, newUserId(), {
      collection,
      ownerId: uid,
      limit: 10,
      cursor: "",
    });
    expect(listed.error).toBeNull();
    expect(listed.code).toBe(Code.OK);
    expect(listed.value?.objects).toHaveLength(0);
    expect(listed.value?.cursor).toBe("");
  });

  it("test_storage_list_no_repeats", async () => {
    // 溯源: server/core_storage_test.go::TestStorageListNoRepeats
    const env = storageEnv();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);
    const collection = generateString();

    const ops = ["1", "2", "3", "4", "5", "6", "7"].map((key) =>
      op({ collection, key, value: "{}", read: 2, write: 1 }),
    );
    const written = await attemptWrite(env, uid, ops);
    expect(written.error).toBeNull();
    expect(written.value).toHaveLength(7);

    const listed = await attemptList(env, newUserId(), {
      collection,
      ownerId: uid,
      limit: 10,
      cursor: "",
    });
    expect(listed.error).toBeNull();
    expect(listed.value?.objects).toHaveLength(7);
    // 无重复：key 集合恰好是 1..7。
    expect([...(listed.value?.objects ?? [])].map((row) => row.key).sort()).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
    ]);
    expect(listed.value?.cursor).toBe("");
  });
});

