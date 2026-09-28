/**
 * M2 / REQ-0001-006：版本覆盖语义
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
  expectedVersion,
  generateString,
  insertUser,
  newUserId,
  op,
  read,
  storageEnv,
} from "../../helpers/storage-domain";

describe("M2 契约: 版本覆盖语义", () => {
  it("test_storage_overrwrite_empty_and_non_empty_versions", async () => {
    // 溯源: server/core_storage_test.go::TestStorageOverrwriteEmptyAndNonEmptyVersions
    const env = storageEnv();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);
    const collection = generateString();

    const first = await attemptWrite(env, uid, [
      op({ collection, key: "7", value: '{"testKey":"testValue1"}', read: 2, write: 1, version: "" }),
    ]);
    expect(first.error).toBeNull();
    expect(first.code).toBe(Code.OK);
    expect(first.value).toHaveLength(1);

    // 空版本（last write wins）覆盖掉上一次写的版本号。
    const second = await attemptWrite(env, uid, [
      op({ collection, key: "7", value: '{"testKey":"testValue2"}', read: 2, write: 1, version: "" }),
    ]);
    expect(second.error).toBeNull();
    expect(second.code).toBe(Code.OK);
    expect(second.value).toHaveLength(1);

    // 拿到上一步的版本号，做一次正常的 OCC 写。
    const third = await attemptWrite(env, uid, [
      op({
        collection,
        key: "7",
        value: '{"testKey":"testValue3"}',
        read: 2,
        write: 1,
        version: second.value?.[0]?.version,
      }),
    ]);
    expect(third.error).toBeNull();
    expect(third.code).toBe(Code.OK);
    expect(third.value).toHaveLength(1);
    expect(third.value?.[0]?.version).toBe(expectedVersion('{"testKey":"testValue3"}'));
  });
});

