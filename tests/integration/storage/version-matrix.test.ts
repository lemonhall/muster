/**
 * M2 / REQ-0001-006：版本与权限矩阵（表驱动）
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

/** 上游 `writeTestDBState`：库里的初始状态 + 这次写操作的预期结果。 */
interface WriteState {
  /** 准备阶段的 write 位（0 或 1）。 */
  readonly write: number;
  /** 准备阶段的值；`""` 表示"这个对象不存在"。 */
  readonly value: string;
  readonly expectedCode: number;
  readonly expectedError: string | null;
  readonly descr: string;
}

/**
 * 上游 `testWrite` 的表驱动搬运：
 * 库状态（write 位 × 值）× 写入参数（无 OCC / 只许新建 / OCC）。
 */
async function testWriteMatrix(
  newValue: string,
  prevValue: string,
  permWrite: number,
  authoritative: boolean,
  states: readonly WriteState[],
): Promise<void> {
  const env = storageEnv();
  const collection = "testcollection";
  const userId = newUserId();
  await insertUser(STORAGE_TENANT, userId);

  for (const state of states) {
    // 每个状态用一个新的 key，状态之间互不影响（上游也是每个 t.Run 里 GenerateString）。
    const key = generateString();
    if (state.value !== "") {
      const prepared = await attemptWrite(
        env,
        userId,
        [op({ collection, key, value: state.value, read: 2, write: state.write })],
        true,
      );
      expect(prepared.error, `准备状态失败：${state.descr}`).toBeNull();
    }

    // 上游：prevVal 为 "" 或 "*" 时原样用；否则换算成它的 MD5 十六进制。
    const version =
      prevValue !== "" && prevValue !== "*" ? expectedVersion(prevValue) : prevValue;

    const result = await attemptWrite(
      env,
      userId,
      [op({ collection, key, value: newValue, read: 2, write: permWrite, version })],
      authoritative,
    );

    expect(result.code, `code 不符：${state.descr}`).toBe(state.expectedCode);
    expect(result.error, `err 不符：${state.descr}`).toBe(state.expectedError);
  }
}

describe("M2 契约: 版本与权限矩阵（表驱动）", () => {
  const V = "{}";

  it("test_non_occ_non_authoritative", async () => {
    // 溯源: server/core_storage_test.go::TestNonOCCNonAuthoritative
    await testWriteMatrix('{"newV": true}', "", 1, false, [
      { write: 0, value: "", expectedCode: Code.OK, expectedError: null, descr: "did not exists" },
      { write: 1, value: V, expectedCode: Code.OK, expectedError: null, descr: "existed and permission allows write, version match" },
      { write: 1, value: '{"a":1}', expectedCode: Code.OK, expectedError: null, descr: "existed and permission allows write, version does not match" },
      { write: 0, value: V, expectedCode: Code.InvalidArgument, expectedError: WRITE_REJECTED_PERMISSION, descr: "existed and permission reject, version match" },
      { write: 0, value: '{"a":1}', expectedCode: Code.InvalidArgument, expectedError: WRITE_REJECTED_PERMISSION, descr: "existed and permission reject, version does not match" },
    ]);
  });

  it("test_non_occ_authoritative", async () => {
    // 溯源: server/core_storage_test.go::TestNonOCCAuthoritative
    await testWriteMatrix('{"newV": true}', "", 1, true, [
      { write: 0, value: "", expectedCode: Code.OK, expectedError: null, descr: "did not exists" },
      { write: 1, value: V, expectedCode: Code.OK, expectedError: null, descr: "existed and permission allows write, version match" },
      { write: 1, value: '{"a":1}', expectedCode: Code.OK, expectedError: null, descr: "existed and permission allows write, version does not match" },
      { write: 0, value: V, expectedCode: Code.OK, expectedError: null, descr: "existed and permission reject, version match" },
      { write: 0, value: '{"a":1}', expectedCode: Code.OK, expectedError: null, descr: "existed and permission reject, version does not match" },
    ]);
  });

  it("test_occ_not_exists_authoritative", async () => {
    // 溯源: server/core_storage_test.go::TestOCCNotExistsAuthoritative
    await testWriteMatrix('{"newV": true}', "*", 1, true, [
      { write: 0, value: "", expectedCode: Code.OK, expectedError: null, descr: "did not exists" },
      { write: 1, value: V, expectedCode: Code.FailedPrecondition, expectedError: WRITE_REJECTED_VERSION, descr: "existed and permission allows write, version match" },
      { write: 1, value: '{"a":1}', expectedCode: Code.FailedPrecondition, expectedError: WRITE_REJECTED_VERSION, descr: "existed and permission allows write, version does not match" },
      { write: 0, value: V, expectedCode: Code.FailedPrecondition, expectedError: WRITE_REJECTED_VERSION, descr: "existed and permission reject, version match" },
      { write: 0, value: '{"a":1}', expectedCode: Code.FailedPrecondition, expectedError: WRITE_REJECTED_VERSION, descr: "existed and permission reject, version does not match" },
    ]);
  });

  it("test_occ_not_exists_non_authoritative", async () => {
    // 溯源: server/core_storage_test.go::TestOCCNotExistsNonAuthoritative
    await testWriteMatrix('{"newV": true}', "*", 1, false, [
      { write: 0, value: "", expectedCode: Code.OK, expectedError: null, descr: "did not exists" },
      { write: 1, value: V, expectedCode: Code.FailedPrecondition, expectedError: WRITE_REJECTED_VERSION, descr: "existed and permission allows write, version match" },
      { write: 1, value: '{"a":1}', expectedCode: Code.FailedPrecondition, expectedError: WRITE_REJECTED_VERSION, descr: "existed and permission allows write, version does not match" },
      { write: 0, value: V, expectedCode: Code.FailedPrecondition, expectedError: WRITE_REJECTED_VERSION, descr: "existed and permission reject, version match" },
      { write: 0, value: '{"a":1}', expectedCode: Code.FailedPrecondition, expectedError: WRITE_REJECTED_VERSION, descr: "existed and permission reject, version does not match" },
    ]);
  });

  it("test_occ_write_non_authoritative", async () => {
    // 溯源: server/core_storage_test.go::TestOCCWriteNonAuthoritative
    await testWriteMatrix('{"newV": true}', V, 1, false, [
      { write: 0, value: "", expectedCode: Code.FailedPrecondition, expectedError: WRITE_REJECTED_VERSION, descr: "did not exists" },
      { write: 1, value: V, expectedCode: Code.OK, expectedError: null, descr: "existed and permission allows write, version match" },
      { write: 1, value: '{"a":1}', expectedCode: Code.FailedPrecondition, expectedError: WRITE_REJECTED_VERSION, descr: "existed and permission allows write, version does not match" },
      { write: 0, value: V, expectedCode: Code.InvalidArgument, expectedError: WRITE_REJECTED_PERMISSION, descr: "existed and permission reject, version match" },
      { write: 0, value: '{"a":1}', expectedCode: Code.InvalidArgument, expectedError: WRITE_REJECTED_PERMISSION, descr: "existed and permission reject, version does not match" },
    ]);
  });

  it("test_occ_write_authoritative", async () => {
    // 溯源: server/core_storage_test.go::TestOCCWriteAuthoritative
    await testWriteMatrix('{"newV": true}', V, 1, true, [
      { write: 0, value: "", expectedCode: Code.FailedPrecondition, expectedError: WRITE_REJECTED_VERSION, descr: "did not exists" },
      { write: 1, value: V, expectedCode: Code.OK, expectedError: null, descr: "existed and permission allows write, version match" },
      { write: 1, value: '{"a":1}', expectedCode: Code.FailedPrecondition, expectedError: WRITE_REJECTED_VERSION, descr: "existed and permission allows write, version does not match" },
      { write: 0, value: V, expectedCode: Code.OK, expectedError: null, descr: "existed and permission reject, version match" },
      { write: 0, value: '{"a":1}', expectedCode: Code.FailedPrecondition, expectedError: WRITE_REJECTED_VERSION, descr: "existed and permission reject, version does not match" },
    ]);
  });

  it("test_occ_write_same_value_with_outdated_version_fail", async () => {
    // 溯源: server/core_storage_test.go::TestOCCWriteSameValueWithOutdatedVersionFail
    const env = storageEnv();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);
    const collection = generateString();
    const key = generateString();

    const created = await attemptWrite(
      env,
      uid,
      [op({ collection, key, value: '{"closed":false}', version: "" })],
      true,
    );
    expect(created.error).toBeNull();
    expect(created.value).toHaveLength(1);

    const outdatedVersion = created.value?.[0]?.version;
    const updated = await attemptWrite(
      env,
      uid,
      [op({ collection, key, value: '{"closed":true}', version: outdatedVersion })],
      true,
    );
    expect(updated.error).toBeNull();
    expect(updated.value).toHaveLength(1);

    // 值没变、但版本号已经过期 → 必须失败（这正是"同值不同版本"的坑）。
    const stale = await attemptWrite(
      env,
      uid,
      [op({ collection, key, value: '{"closed":true}', version: outdatedVersion })],
      true,
    );
    expect(stale.value).toBeNull();
    expect(stale.error).toBe(WRITE_REJECTED_VERSION);
  });

  it("test_occ_write_same_value_correct_version_success", async () => {
    // 溯源: server/core_storage_test.go::TestOCCWriteSameValueCorrectVersionSuccess
    const env = storageEnv();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);
    const collection = generateString();
    const key = generateString();

    const created = await attemptWrite(
      env,
      uid,
      [op({ collection, key, value: '{"closed":false}', version: "" })],
      true,
    );
    expect(created.error).toBeNull();
    expect(created.value).toHaveLength(1);

    const updated = await attemptWrite(
      env,
      uid,
      [op({ collection, key, value: '{"closed":true}', version: created.value?.[0]?.version })],
      true,
    );
    expect(updated.error).toBeNull();
    expect(updated.value).toHaveLength(1);

    // 用**当前**版本号重写同一个值 → 成功。
    const again = await attemptWrite(
      env,
      uid,
      [op({ collection, key, value: '{"closed":true}', version: updated.value?.[0]?.version })],
      true,
    );
    expect(again.error).toBeNull();
    expect(again.value).toHaveLength(1);
    expect(again.value?.[0]?.version).toBe(expectedVersion('{"closed":true}'));
  });
});

