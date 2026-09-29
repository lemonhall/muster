import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  authenticateDeviceOrFail,
  basicAuth,
  bearer,
  call,
  createTenant,
  findUserByIdentity,
  type TestTenant,
} from "../../helpers/tenants";

/**
 * M9 运维面：限流（DoD 9）。
 *
 * 反作弊点是"证明这是限流，而不是别的错误"：超限那一条必须同时断言 **429** +
 * `google.rpc.Status` 形状的错误体 + `retry-after` 头，并且用**同一租户在阈值内
 * 仍然 200** 做对照——只看到 429 不能排除"路由炸了""鉴权失败了"。
 *
 * 另外两条容易被写虚的语义在这里各有一条用例：**窗口滑过要恢复**（否则限流会变成
 * 永久封禁），**租户之间必须隔离**（A 游戏被打满不能让 B 游戏跟着掉线）。
 *
 * 阈值注入方式：`RATE_LIMIT_PER_WINDOW` / `RATE_LIMIT_WINDOW_MS` 是可选绑定，
 * 缺省即关闭。测试直接改测试环境里的这两个绑定（vitest 池给每个测试文件一个
 * isolate，`afterAll` 再还原），不需要动 `wrangler.jsonc` 的公共配置。
 *
 * 每个用例都**自己开一个租户**：桶是按"租户 + 主体"计的，复用租户会让上一条用例
 * 的计数漏进下一条（而且工装自己发的 HTTP 请求也会计数——这正是"真在这条路上",
 * 不是缺陷）。开新租户等于每个用例一份全新的桶。
 *
 * 契约源（机器可读）：
 * 契约源: 无（上游没有等价中间件；载体与语义登记在 ECN-0014 偏差 4）
 *
 * REQ-0001-023
 */

const LIMIT = 3;
const WINDOW_MS = 1_000;
/** 窗口滑过的等待：比窗口长一点，避免把机器调度抖动算进结论。 */
const WINDOW_SLIP_MS = WINDOW_MS + 150;

const OVER_LIMIT_MESSAGE = /^Rate limit exceeded\. Retry after [1-9]\d*s\.$/u;

type MutableEnv = Record<string, unknown>;

function setBinding(name: string, value: string): void {
  (env as unknown as MutableEnv)[name] = value;
}

function clearBinding(name: string): void {
  delete (env as unknown as MutableEnv)[name];
}

beforeAll(() => {
  setBinding("RATE_LIMIT_PER_WINDOW", String(LIMIT));
  setBinding("RATE_LIMIT_WINDOW_MS", String(WINDOW_MS));
});

afterAll(() => {
  clearBinding("RATE_LIMIT_PER_WINDOW");
  clearBinding("RATE_LIMIT_WINDOW_MS");
});

/** 新租户。**只写 D1、不发 HTTP**，所以它的限流桶是干净的。 */
async function freshTenant(): Promise<TestTenant> {
  const id = crypto.randomUUID().toUpperCase();
  return await createTenant(id, `server-key-${id}`, "rate-limit");
}

/**
 * 新账号：只走认证端点（server key 路由），**不碰任何用户路由**。
 * 返回的 user id 就是用户路由的桶名，此刻这个桶里是 0。
 */
async function freshUser(tenant: TestTenant): Promise<{ readonly id: string; readonly token: string }> {
  const deviceId = `dev-${crypto.randomUUID()}`;
  const session = await authenticateDeviceOrFail(tenant, deviceId);
  const user = await findUserByIdentity(tenant.id, "device", deviceId);
  if (user === null) throw new Error("认证之后应该在 users 表里找到这个人");
  return { id: user.id, token: session.token };
}

function consoleList(serverKey: string): Promise<Response> {
  return call("/v2/console/user", { authorization: basicAuth(serverKey) });
}

async function exhaustionRun(serverKey: string): Promise<readonly number[]> {
  const statuses: number[] = [];
  for (let index = 0; index <= LIMIT; index += 1) {
    statuses.push((await consoleList(serverKey)).status);
  }
  return statuses;
}

describe("M9 限流: 阈值与拒绝形状", () => {
  it("test_requests_within_the_threshold_pass_and_the_next_one_is_429", async () => {
    const world = await freshTenant();

    const allowed: number[] = [];
    for (let index = 0; index < LIMIT; index += 1) {
      allowed.push((await consoleList(world.serverKey)).status);
    }
    // 对照：同样的请求、同一个租户，阈值内每一条都是 200。
    expect(allowed).toEqual([200, 200, 200]);

    const over = await consoleList(world.serverKey);
    expect(over.status).toBe(429);
    expect(over.headers.get("content-type")).toBe("application/json");
    const retryAfter = over.headers.get("retry-after") ?? "";
    expect(retryAfter).toMatch(/^[1-9]\d*$/u);
    expect(Number(retryAfter)).toBeLessThanOrEqual(Math.ceil(WINDOW_MS / 1000) + 1);
    // 错误体就是 google.rpc.Status：code 8 = ResourceExhausted。
    expect(await over.json()).toEqual({
      code: 8,
      message: expect.stringMatching(OVER_LIMIT_MESSAGE) as unknown as string,
    });
  });

  it("test_the_window_slides_and_the_bucket_refills", async () => {
    const world = await freshTenant();
    expect(await exhaustionRun(world.serverKey)).toEqual([200, 200, 200, 429]);

    await new Promise((resolve) => setTimeout(resolve, WINDOW_SLIP_MS));
    // 窗口滑过之后必须恢复：限流不是永久封禁。
    expect((await consoleList(world.serverKey)).status).toBe(200);
  });
});

describe("M9 限流: 租户隔离与主体粒度", () => {
  it("test_a_second_tenant_is_not_affected_by_the_first_one_being_exhausted", async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    expect(await exhaustionRun(a.serverKey)).toEqual([200, 200, 200, 429]);

    // A 打满不影响 B：桶挂在"每租户一个限流 DO"上。
    expect((await consoleList(b.serverKey)).status).toBe(200);
  });

  it("test_user_routes_are_counted_per_user_inside_the_same_tenant", async () => {
    const world = await freshTenant();
    const first = await freshUser(world);
    const second = await freshUser(world);

    const statuses: number[] = [];
    for (let index = 0; index <= LIMIT; index += 1) {
      statuses.push((await call("/v2/account", { authorization: bearer(first.token) })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);

    // 同租户的另一个玩家有自己的桶：一个人的客户端刷屏不该把别人一起限掉。
    expect((await call("/v2/account", { authorization: bearer(second.token) })).status).toBe(200);
  });

  it("test_the_rejection_lands_in_the_request_log_for_ops", async () => {
    const world = await freshTenant();
    const requestId = `rate-limit-${crypto.randomUUID()}`;
    for (let index = 0; index < LIMIT; index += 1) {
      await call("/v2/console/user", {
        authorization: basicAuth(world.serverKey),
        requestId: `${requestId}-${index}`,
      });
    }
    const over = await call("/v2/console/user", {
      authorization: basicAuth(world.serverKey),
      requestId: `${requestId}-over`,
    });
    expect(over.status).toBe(429);

    const row = await env.DB.prepare(
      "SELECT status FROM request_log WHERE tenant_id = ?1 AND request_id = ?2",
    )
      .bind(world.id, `${requestId}-over`)
      .first<{ status: number }>();
    // 运维要看得到"谁在被打回"，所以 429 也要留一行日志。
    expect(row?.status).toBe(429);
  });
});
