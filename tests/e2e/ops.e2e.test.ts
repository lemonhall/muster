import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { opsBaseUrl, opsTenantA, opsTenantB, startOpsServer, stopOpsServer } from "./ops-server";

/**
 * M9 运维面（DoD 9）的 **E2E 那一半**：在真进程、真 HTTP 上**打到 429**。
 *
 * 集成测试已经在 workerd 池里证明过窗口语义；这里只钉三件池里证明不了的事：
 *
 *   1. 429 是**真的**从 HTTP 通道传出来的（状态码、`retry-after` 头、错误体一起过一遍网络）；
 *   2. 拒绝之后**另一个租户仍然 200**——限流的桶确实按租户分；
 *   3. 每条响应都带 `x-request-id`（限流的拒绝也不能把请求 ID 关联漏掉）。
 *
 * 顺带把"窗口滑过要恢复"也钉在真通道上：桶不是永久封禁。
 *
 * **这个文件自己起一个专属 dev server**（`ops-server.ts`）。理由不是"图方便"：
 * 限流阈值是全局变量，而存储那条翻页用例（约 200 条请求挤在 50 秒里，约 4 次/秒）要求
 * 阈值高到打不满，限流用例要求阈值低到几秒打满——同一份配置下这两件事互相排斥。
 * 拆成两个部署各自拧阈值，既让两边都能成立，也正好演示了"阈值可配"这个 DoD 条目。
 *
 * 契约源（机器可读）：
 * 契约源: 无（上游没有等价中间件；载体与语义登记在 ECN-0014 偏差 4）
 *
 * REQ-0001-023
 */

const LIMIT = 3;
const WINDOW_MS = 15_000;

/** 一条计入 server-key 桶的廉价请求：列本租户的控制台用户。 */
function consoleList(serverKey: string): Promise<Response> {
  return fetch(`${opsBaseUrl}/v2/console/user`, {
    headers: { authorization: `Basic ${Buffer.from(`${serverKey}:`, "utf8").toString("base64")}` },
  });
}

beforeAll(async () => {
  await startOpsServer({ limit: LIMIT, windowMs: WINDOW_MS });
});

afterAll(() => {
  stopOpsServer();
});

describe("M9 运维面 E2E: 429 与租户隔离", () => {
  it(
    "test_the_tenant_is_throttled_with_a_retry_hint_and_the_next_tenant_is_not",
    async () => {
      // 阈值内的每一条都仍然 200：证明"稍后的 429 是限流"而不是"路由或鉴权坏了"。
      for (let index = 0; index < LIMIT; index += 1) {
        const response = await consoleList(opsTenantA.serverKey);
        expect(response.status).toBe(200);
      }

      const over = await consoleList(opsTenantA.serverKey);
      expect(over.status).toBe(429);
      expect(over.headers.get("content-type")).toBe("application/json");
      expect(over.headers.get("retry-after")).toMatch(/^[1-9]\d*$/u);
      expect(Number(over.headers.get("retry-after"))).toBeLessThanOrEqual(WINDOW_MS / 1000);
      expect(over.headers.get("x-request-id")).not.toBeNull();
      const body = (await over.json()) as { code: number; message: string };
      expect(body.code).toBe(8);
      expect(body.message).toMatch(/^Rate limit exceeded\. Retry after [1-9]\d*s\.$/u);

      // 另一个租户不受影响：桶挂在"每租户一个限流 DO"上。
      const other = await consoleList(opsTenantB.serverKey);
      expect(other.status).toBe(200);

      // 窗口滑过必须恢复：限流不是永久封禁。
      await new Promise((resolve) => setTimeout(resolve, WINDOW_MS + 300));
      expect((await consoleList(opsTenantA.serverKey)).status).toBe(200);
    },
    180_000,
  );
});
