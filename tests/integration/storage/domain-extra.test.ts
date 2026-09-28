/**
 * M2 / REQ-0001-006：批量原子性 / 权限矩阵 / 游标 / 租户隔离
 *
 * 这些是本项目自己的契约测试（上游没有对应用例），期望值由上游源码与 proto 定义逐条推出，
 * 每条都带 `契约源:` 指向具体的上游代码位置。
 *
 * 公共工装见 `tests/helpers/storage-domain.ts`；测试只跑本地 workerd + 本地 D1，
 * 不碰任何 Cloudflare 远端资源。
 */

import { describe, expect, it } from "vitest";

import {
  Code,
  NIL_USER_ID,
  OTHER_TENANT,
  READ_OWNER,
  READ_PRIVATE,
  READ_PUBLIC,
  STORAGE_TENANT,
  WRITE_REJECTED_PERMISSION,
  WRITE_REJECTED_VERSION,
  attemptList,
  attemptWrite,
  deleteObjects,
  encodeCursor,
  expectedVersion,
  generateString,
  insertUser,
  listObjects,
  newUserId,
  op,
  read,
  readObjects,
  storageEnv,
  writeObjects,
} from "../../helpers/storage-domain";

describe("M2 自主契约测试: 批量原子性 / 权限矩阵 / 游标 / 租户隔离", () => {
  it("test_batch_write_hundred_is_all_or_nothing", async () => {
    // 契约源: server/core_storage.go::StorageWriteObjects
    // 契约源: server/core_storage.go::storagePrepBatch
    const env = storageEnv();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);
    const collection = generateString();

    // 100 条里第 100 条注定失败（版本号对不上）→ 整批必须一条都不落库。
    const doomed = Array.from({ length: 100 }, (_unused, index) =>
      op({
        collection,
        key: `k${String(index).padStart(3, "0")}`,
        value: `{"i":${index}}`,
        version: index === 99 ? "fail" : "",
        read: 1,
        write: 1,
      }),
    );
    const rejected = await attemptWrite(env, uid, doomed);
    expect(rejected.value).toBeNull();
    expect(rejected.code).toBe(Code.FailedPrecondition);
    expect(rejected.error).toBe(WRITE_REJECTED_VERSION);

    const afterFailure = await listObjects(env, uid, {
      collection,
      ownerId: uid,
      limit: 100,
      cursor: "",
    });
    expect(afterFailure.objects).toHaveLength(0);

    // 把那条改对，再写一次：100 条必须全部落库、版本号全部正确。
    const fixed = doomed.map((entry, index) =>
      index === 99 ? { ...entry, version: "" } : entry,
    );
    const accepted = await attemptWrite(env, uid, fixed);
    expect(accepted.error).toBeNull();
    expect(accepted.value).toHaveLength(100);
    for (const [index, ack] of (accepted.value ?? []).entries()) {
      expect(ack.version).toBe(expectedVersion(`{"i":${index}}`));
    }

    const afterSuccess = await listObjects(env, uid, {
      collection,
      ownerId: uid,
      limit: 100,
      cursor: "",
    });
    expect(afterSuccess.objects).toHaveLength(100);
  });

  it("test_permission_matrix_read_and_write_grid", async () => {
    // 契约源: server/core_storage.go::StorageReadObjects
    // 契约源: server/core_storage.go::storagePrepBatch
    const env = storageEnv();
    const owner = newUserId();
    const other = newUserId();
    await insertUser(STORAGE_TENANT, owner);

    // read 位 × 观察者（属主 / 他人 / 运行时）的可见性格。
    const visibility: ReadonlyArray<readonly [number, boolean, boolean, boolean]> = [
      // [read_perm, 属主可见, 他人可见, 运行时可见]
      [READ_PRIVATE, false, false, true],
      [READ_OWNER, true, false, true],
      [READ_PUBLIC, true, true, true],
    ];

    for (const [readPerm, ownerSees, otherSees, runtimeSees] of visibility) {
      const collection = generateString();
      const key = "shared";
      const written = await attemptWrite(env, owner, [
        op({ collection, key, value: '{"v":1}', read: readPerm, write: 1 }),
      ]);
      expect(written.error).toBeNull();
      // 写回的 ack 里没有权限位（上游 `StorageObjectAck` 同样没有），权限要看读回来的对象。
      expect(written.value?.[0]?.version).toBe(expectedVersion('{"v":1}'));

      const id = { collection, key, userId: owner };
      expect((await read(env, owner, [id])).length > 0, `属主 read=${readPerm}`).toBe(ownerSees);
      expect((await read(env, other, [id])).length > 0, `他人 read=${readPerm}`).toBe(otherSees);
      expect((await read(env, NIL_USER_ID, [id])).length > 0, `运行时 read=${readPerm}`).toBe(
        runtimeSees,
      );
    }

    // write 位：属主改不动 write=0 的对象，但**新建**时写位由请求决定（上游如此）。
    const collection = generateString();
    const writable = await attemptWrite(env, owner, [
      op({ collection, key: "writable", value: '{"v":1}', read: 1, write: 1 }),
      op({ collection, key: "frozen", value: '{"v":1}', read: 1, write: 0 }),
    ]);
    expect(writable.error).toBeNull();

    const ownerOverwrite = await attemptWrite(env, owner, [
      op({ collection, key: "writable", value: '{"v":2}', read: 1, write: 1 }),
    ]);
    expect(ownerOverwrite.error).toBeNull();

    const ownerOverwriteFrozen = await attemptWrite(env, owner, [
      op({ collection, key: "frozen", value: '{"v":2}', read: 1, write: 1 }),
    ]);
    expect(ownerOverwriteFrozen.code).toBe(Code.InvalidArgument);
    expect(ownerOverwriteFrozen.error).toBe(WRITE_REJECTED_PERMISSION);

    // 存储的键是 (collection, key, user_id)：另一个用户写同一个 collection+key
    // 得到的是**他自己**的对象，碰不到属主那一份（上游 `storage` 表的主键就是这样）。
    const otherWritesSameKey = await attemptWrite(env, other, [
      op({ collection, key: "writable", value: '{"v":3}', read: 2, write: 1 }),
    ]);
    expect(otherWritesSameKey.error).toBeNull();
    expect(
      (await read(env, owner, [{ collection, key: "writable", userId: owner }]))[0]?.value,
    ).toBe('{"v":2}');
    expect(
      (await read(env, other, [{ collection, key: "writable", userId: other }]))[0]?.value,
    ).toBe('{"v":3}');

    // 运行时（authoritative）可以改任何对象。
    const runtimeOverwrite = await attemptWrite(
      env,
      owner,
      [op({ collection, key: "frozen", value: '{"v":4}', read: 1, write: 1 })],
      true,
    );
    expect(runtimeOverwrite.error).toBeNull();
  });

  it("test_cursor_pagination_walks_everything_exactly_once", async () => {
    // 契约源: server/core_storage.go::StorageListObjects
    // 契约源: server/core_storage.go::storageListObjects
    const env = storageEnv();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);
    const collection = generateString();

    const total = 250;
    const ops = Array.from({ length: total }, (_unused, index) =>
      op({
        collection,
        key: `k${String(index).padStart(4, "0")}`,
        value: `{"i":${index}}`,
        read: 1,
        write: 1,
      }),
    );
    for (let offset = 0; offset < ops.length; offset += 50) {
      const batch = await attemptWrite(env, uid, ops.slice(offset, offset + 50));
      expect(batch.error).toBeNull();
    }

    const limit = 7;
    const seen: string[] = [];
    let cursor = "";
    let pages = 0;
    for (;;) {
      const page = await listObjects(env, uid, { collection, ownerId: uid, limit, cursor });
      pages += 1;
      expect(pages, "翻页不收敛").toBeLessThanOrEqual(total + 5);
      for (const row of page.objects) seen.push(row.key);
      if (page.cursor === "") break;
      expect(page.cursor, "游标没有前进").not.toBe(cursor);
      cursor = page.cursor;
    }

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect([...seen].sort()).toEqual(ops.map((entry) => entry.key).sort());

    // 游标指向所有行之后（严格大于）→ 空页 + 空游标，不报错也不回绕。
    const past = encodeCursor({ read: 1, key: "zzzz", userId: uid });
    const beyond = await listObjects(env, uid, { collection, ownerId: uid, limit, cursor: past });
    expect(beyond.objects).toHaveLength(0);
    expect(beyond.cursor).toBe("");
  });

  it("test_malformed_cursor_is_rejected_with_upstream_message", async () => {
    // 契约源: server/core_storage.go::StorageListObjects
    const env = storageEnv();
    const uid = newUserId();
    await insertUser(STORAGE_TENANT, uid);

    for (const bad of ["!!!not-base64!!!", "e30", "eyJyIjozfQ", "eyJyIjoxLCJrIjoxfQ"]) {
      const result = await attemptList(env, uid, {
        collection: generateString(),
        ownerId: uid,
        limit: 10,
        cursor: bad,
      });
      expect(result.value, `非法游标应被拒绝：${bad}`).toBeNull();
      expect(result.code).toBe(Code.InvalidArgument);
      expect(result.error).toBe("Malformed cursor was used.");
    }
  });

  it("test_tenant_isolation_keeps_storage_domains_apart", async () => {
    // 契约源: server/core_storage.go::StorageListObjects
    const tenantA = storageEnv(STORAGE_TENANT);
    const tenantB = storageEnv(OTHER_TENANT, 1_700_000_123);
    const uid = newUserId();
    const collection = generateString();

    const inA = await writeObjects(
      tenantA,
      uid,
      [op({ collection, key: "k", value: '{"tenant":"a"}', read: 2, write: 1 })],
    );
    const inB = await writeObjects(
      tenantB,
      uid,
      [op({ collection, key: "k", value: '{"tenant":"b"}', read: 2, write: 1 })],
    );
    expect(inA[0]?.version).toBe(expectedVersion('{"tenant":"a"}'));
    expect(inB[0]?.version).toBe(expectedVersion('{"tenant":"b"}'));

    // 同一个 (collection, key, user_id) 在两个租户下是两个独立对象。
    const readA = await readObjects(tenantA, uid, [{ collection, key: "k", userId: uid }]);
    const readB = await readObjects(tenantB, uid, [{ collection, key: "k", userId: uid }]);
    expect(readA.map((row) => row.value)).toEqual(['{"tenant":"a"}']);
    expect(readB.map((row) => row.value)).toEqual(['{"tenant":"b"}']);

    // 一个租户里删掉，不影响另一个。
    await deleteObjects(tenantA, uid, [{ collection, key: "k", version: "" }]);
    expect(await readObjects(tenantA, uid, [{ collection, key: "k", userId: uid }])).toHaveLength(0);
    expect(await readObjects(tenantB, uid, [{ collection, key: "k", userId: uid }])).toHaveLength(1);
  });
});
