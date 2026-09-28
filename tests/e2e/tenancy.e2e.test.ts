import { describe, expect, it } from "vitest";

import { e2eTenant, e2eTenantB } from "./global-setup";
import { authenticateDevice, call, freshDeviceId, userIdOf } from "./http-helpers";

/**
 * M1 E2E：多租户隔离，走真实 HTTP 通道。
 *
 * 存在的唯一目的：让"一个 Cloudflare 账号上跑多个游戏、彼此看不见"这条结论
 * **在真实 HTTP 通道上**被验证——不是只在直接 import 处理器的集成测试里成立。
 * 没有它，跨租户越权就没有 E2E 证据。
 *
 * 与 `identity.e2e.test.ts` 的分工：那边只管"单个租户内的身份/会话/账号是否真的成立"，
 * 这边只管"两个租户之间是否真的隔开"。
 *
 * 目标是一个本地 `wrangler dev --local` 进程（见 `global-setup.ts`），
 * 不连接任何 Cloudflare 账号资源，因此不产生账单。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_authenticate.go::AuthenticateDevice
 * 契约源: server/api_user.go::GetUsers
 * 契约源: server/api.go::securityInterceptorFunc
 *
 * REQ-0001-026
 */

describe("M1 E2E: 多租户隔离（真实 HTTP）", () => {
  it("test_same_device_id_in_two_tenants_yields_two_distinct_accounts", async () => {
    const deviceId = freshDeviceId("shared");
    const a = await authenticateDevice(e2eTenant, deviceId);
    const b = await authenticateDevice(e2eTenantB, deviceId);

    expect(a.session.created).toBe(true);
    expect(b.session.created).toBe(true);
    const userA = await userIdOf(a.session.token);
    const userB = await userIdOf(b.session.token);
    expect(userA).not.toBe(userB);
  });

  it("test_tenant_token_cannot_read_another_tenants_user", async () => {
    const deviceId = freshDeviceId("cross");
    const a = await authenticateDevice(e2eTenant, deviceId);
    const b = await authenticateDevice(e2eTenantB, deviceId);
    const userA = await userIdOf(a.session.token);

    // B 的令牌查 A 的用户 id：查得到才是泄漏。这里必须是"查不到"，而且形状与上游一致（空对象）。
    const peerQuery = await call(`/v2/user?ids=${userA}`, { token: b.session.token });
    expect(peerQuery.status).toBe(200);
    expect(await peerQuery.json()).toEqual({});

    // A 的令牌查 A 的用户 id：这才是正主，必须有。
    const ownQuery = await call(`/v2/user?ids=${userA}`, { token: a.session.token });
    expect(ownQuery.status).toBe(200);
    const own = (await ownQuery.json()) as { users: { id: string }[] };
    expect(own.users.map((user) => user.id)).toEqual([userA]);
  });

  it("test_same_username_can_live_in_two_tenants", async () => {
    const username = `dupe-${crypto.randomUUID().slice(0, 8)}`;
    const a = await authenticateDevice(
      e2eTenant,
      freshDeviceId("u"),
      `?create=true&username=${username}`,
    );
    const b = await authenticateDevice(
      e2eTenantB,
      freshDeviceId("u"),
      `?create=true&username=${username}`,
    );

    const tokenA = a.session.token;
    const tokenB = b.session.token;
    const seen = new Set([await userIdOf(tokenA), await userIdOf(tokenB)]);
    expect(seen.size).toBe(2);

    for (const token of [tokenA, tokenB]) {
      const res = await call(`/v2/user?usernames=${username}`, { token });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { users: { username: string }[] };
      // 每个租户只能看到自己那一个同名账号，看不到另一个租户的。
      expect(body.users).toHaveLength(1);
      expect(body.users[0]?.username).toBe(username);
    }
  });
});
