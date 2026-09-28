import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { e2eTenant } from "./global-setup";

/**
 * M2 E2E：存储引擎，走真实 HTTP 通道。
 *
 * 与 `tests/integration/storage/` 的分工是刻意的：集成测试直接 import 领域函数，断言的是
 * **领域语义**；这里只碰网络，断言的是**端到端真的成立**：路由、protojson 线格式、版本号、
 * 游标分页在真实请求下不重不漏。
 *
 * M2 DoD #4 那条"10,000 条对象翻页遍历无重复无遗漏"就落在这里。
 *
 * 目标是一个本地 `wrangler dev --local` 进程（见 `global-setup.ts`），
 * 不连接任何 Cloudflare 账号资源，因此不产生账单。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_storage.go::StorageWriteObjects
 * 契约源: server/core_storage.go::StorageReadObjects
 * 契约源: server/core_storage.go::StorageListObjects
 * 契约源: server/core_storage.go::StorageDeleteObjects
 *
 * REQ-0001-006
 */
const baseUrl =
  process.env.MUSTER_E2E_TARGET ?? `http://127.0.0.1:${process.env.MUSTER_E2E_PORT ?? "8788"}`;

/** 一次批量写的上限（上游同值：一批最多 100 个对象）。 */
const WRITE_BATCH = 100;

interface Session {
  readonly token: string;
  readonly userId: string;
}

interface CallOptions {
  readonly method?: string;
  readonly token?: string;
  readonly body?: unknown;
}

async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

/** `Authorization: Basic base64(<server_key>:)`，与官方 SDK 的写法一致。 */
function basic(serverKey: string): string {
  return `Basic ${Buffer.from(`${serverKey}:`, "utf8").toString("base64")}`;
}

/**
 * 每次运行都新建一个设备用户：本地 D1 是跨运行保留的，复用固定设备 id 会让断言依赖"上一轮"。
 */
async function authenticate(): Promise<Session> {
  const res = await fetch(`${baseUrl}/v2/account/authenticate/device?create=true`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: basic(e2eTenant.serverKey) },
    body: JSON.stringify({ id: `e2e-storage-${crypto.randomUUID()}` }),
  });
  expect(res.status).toBe(200);
  const session = (await res.json()) as { readonly token: string };
  const account = await call("/v2/account", { token: session.token });
  expect(account.status).toBe(200);
  const profile = (await account.json()) as { readonly user?: { readonly id?: string } };
  const userId = profile.user?.id;
  expect(typeof userId).toBe("string");
  return { token: session.token, userId: userId ?? "" };
}

/** 值 → 版本号：上游 `fmt.Sprintf("%x", md5.Sum([]byte(value)))`，这里用 node 的 crypto 独立复算。 */
function expectedVersion(value: string): string {
  return createHash("md5").update(value, "utf8").digest("hex");
}

interface Ack {
  readonly collection: string;
  readonly key: string;
  readonly version: string;
  readonly user_id: string;
}

interface ObjectRow {
  readonly collection: string;
  readonly key: string;
  readonly user_id: string;
  readonly value: string;
  readonly version: string;
}

async function putObjects(
  session: Session,
  objects: readonly { readonly collection: string; readonly key: string; readonly value: string }[],
): Promise<readonly Ack[]> {
  const res = await call("/v2/storage", { method: "PUT", token: session.token, body: { objects } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { readonly acks?: readonly Ack[] };
  return body.acks ?? [];
}

async function deleteObjects(
  session: Session,
  keys: readonly string[],
  collection: string,
): Promise<void> {
  const res = await call("/v2/storage/delete", {
    method: "PUT",
    token: session.token,
    body: { object_ids: keys.map((key) => ({ collection, key })) },
  });
  expect(res.status).toBe(200);
}

describe("M2 E2E: 存储引擎", () => {
  it("test_write_read_back_and_version_over_real_http", { timeout: 60_000 }, async () => {
    const session = await authenticate();
    const collection = `e2e_object_${crypto.randomUUID()}`;
    const key = "greeting";
    const value = JSON.stringify({ hello: "world", n: 1 });

    const first = await putObjects(session, [{ collection, key, value }]);
    expect(first).toHaveLength(1);
    expect(first[0]?.version).toBe(expectedVersion(value));
    expect(first[0]?.user_id).toBe(session.userId);

    // 回读：值逐字节相同，版本号与本地复算一致。
    const readRes = await call("/v2/storage", {
      method: "POST",
      token: session.token,
      body: { object_ids: [{ collection, key, user_id: session.userId }] },
    });
    expect(readRes.status).toBe(200);
    const readBody = (await readRes.json()) as { readonly objects?: readonly ObjectRow[] };
    expect(readBody.objects).toHaveLength(1);
    expect(readBody.objects?.[0]?.value).toBe(value);
    expect(readBody.objects?.[0]?.version).toBe(expectedVersion(value));

    // 覆盖写：值一变，版本号随之改变（版本号就是值的指纹，不是自增计数）。
    const next = JSON.stringify({ hello: "world", n: 2 });
    const second = await putObjects(session, [{ collection, key, value: next }]);
    expect(second[0]?.version).toBe(expectedVersion(next));
    expect(second[0]?.version).not.toBe(first[0]?.version);

    await deleteObjects(session, [key], collection);
    const afterDelete = await call("/v2/storage", {
      method: "POST",
      token: session.token,
      body: { object_ids: [{ collection, key, user_id: session.userId }] },
    });
    expect(((await afterDelete.json()) as { readonly objects?: unknown }).objects).toBeUndefined();
  });

  it("test_paginates_10000_objects_without_duplicates_or_gaps", { timeout: 900_000 }, async () => {
    const total = 10_000;
    const pageLimit = 100;
    const session = await authenticate();
    const collection = `e2e_page_${crypto.randomUUID()}`;
    const keyOf = (index: number): string => `key-${String(index).padStart(5, "0")}`;
    const expectedKeys = Array.from({ length: total }, (_, index) => keyOf(index));

    // 造数据：100 条一批，正好 100 批（上游一批的上限就是 100）。
    for (let start = 0; start < total; start += WRITE_BATCH) {
      const batch = expectedKeys.slice(start, start + WRITE_BATCH).map((key, offset) => ({
        collection,
        key,
        value: JSON.stringify({ n: start + offset }),
      }));
      const acks = await putObjects(session, batch);
      expect(acks).toHaveLength(batch.length);
    }

    // 翻页：游标一路带下去，直到服务端不再给游标。
    const seen: string[] = [];
    const duplicates: string[] = [];
    const unique = new Set<string>();
    let cursor = "";
    let pages = 0;
    for (;;) {
      const query = new URLSearchParams({ user_id: session.userId, limit: String(pageLimit) });
      if (cursor !== "") query.set("cursor", cursor);
      const res = await call(`/v2/storage/${collection}?${query.toString()}`, {
        token: session.token,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        readonly objects?: readonly ObjectRow[];
        readonly cursor?: string;
      };
      const rows = body.objects ?? [];
      pages += 1;
      for (const row of rows) {
        seen.push(row.key);
        if (unique.has(row.key)) duplicates.push(row.key);
        unique.add(row.key);
      }
      cursor = body.cursor ?? "";
      if (cursor === "") break;
      // 防呆门禁：游标翻不动时不要让这个用例变成死循环。
      expect(pages).toBeLessThanOrEqual(total / pageLimit + 1);
    }

    expect(pages).toBe(total / pageLimit);
    expect(seen).toHaveLength(total);
    const expectedSet = new Set(expectedKeys);
    expect(seen.filter((key) => !expectedSet.has(key))).toHaveLength(0);
    expect(seen[0]).toBe(expectedKeys[0]);
    expect(seen[seen.length - 1]).toBe(expectedKeys[expectedKeys.length - 1]);
    // "无重复无遗漏"的两条等价表达：总数与去重计数相等，且恰好是我们要的那 10,000 个键。
    expect(total).toBe(unique.size);
    expect(duplicates).toHaveLength(0);

    // 拆场：同样是 100 条一批，避免本地 D1 被历次运行撑大。
    for (let start = 0; start < total; start += WRITE_BATCH) {
      await deleteObjects(session, expectedKeys.slice(start, start + WRITE_BATCH), collection);
    }
  });
});
