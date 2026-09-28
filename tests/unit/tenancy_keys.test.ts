import { describe, expect, it } from "vitest";

import {
  deriveTenantSessionKey,
  peekTenantId,
  signSessionToken,
  verifySessionToken,
  type SessionClaims,
} from "../../src/domain/identity/token";

/**
 * M1 单元测试：多租户的密码学隔离（ECN-0001）。
 *
 * 为什么这条要有独立的单元测试：集成测试只能从 HTTP 面观察行为，
 * 而"跨租户令牌不可能通过校验"这个结论的根因在**密钥派生**上。
 * 这里直接盯住根因：同一份 claim、不同的租户盐 → 两把互不通用的钥匙。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_authenticate.go::generateRefreshToken
 * 契约源: server/core_session.go::SessionLogout
 *
 * REQ-0001-026
 */

const MASTER = "unit-test-master-secret";
const TENANT_A = "AAAAAAAA-0000-4000-8000-000000000001";
const TENANT_B = "BBBBBBBB-0000-4000-8000-000000000002";

function claims(tenantId: string, exp: number): SessionClaims {
  return {
    tid: "11111111-2222-4333-8444-555555555555",
    uid: "99999999-8888-4777-8666-555555555555",
    usn: "player",
    gid: tenantId,
    iat: 1,
    exp,
  };
}

const future = (): number => Math.floor(Date.now() / 1000) + 3600;

describe("M1 单元: 每租户派生密钥", () => {
  it("test_token_signed_for_one_tenant_does_not_verify_in_another", async () => {
    const keyA = await deriveTenantSessionKey(MASTER, TENANT_A, "session");
    const keyB = await deriveTenantSessionKey(MASTER, TENANT_B, "session");
    const token = await signSessionToken(keyA, claims(TENANT_A, future()));

    expect(await verifySessionToken(keyA, token, { nowSec: Math.floor(Date.now() / 1000) })).not.toBeNull();
    expect(await verifySessionToken(keyB, token, { nowSec: Math.floor(Date.now() / 1000) })).toBeNull();
  });

  it("test_same_tenant_derives_a_stable_key", async () => {
    const first = await deriveTenantSessionKey(MASTER, TENANT_A, "session");
    const second = await deriveTenantSessionKey(MASTER, TENANT_A, "session");
    const token = await signSessionToken(first, claims(TENANT_A, future()));
    expect(await verifySessionToken(second, token, { nowSec: Math.floor(Date.now() / 1000) })).not.toBeNull();
  });

  it("test_session_and_refresh_purposes_are_not_interchangeable", async () => {
    // 上游用两个独立配置项（encryption_key / refresh_encryption_key）达到同一效果：
    // 一个令牌不可能被拿去当另一个用。
    const sessionKey = await deriveTenantSessionKey(MASTER, TENANT_A, "session");
    const refreshKey = await deriveTenantSessionKey(MASTER, TENANT_A, "refresh");
    const token = await signSessionToken(sessionKey, claims(TENANT_A, future()));
    expect(await verifySessionToken(refreshKey, token, { nowSec: Math.floor(Date.now() / 1000) })).toBeNull();
  });

  it("test_different_master_secrets_do_not_produce_the_same_key", async () => {
    const good = await deriveTenantSessionKey(MASTER, TENANT_A, "session");
    const attacker = await deriveTenantSessionKey("attacker-secret", TENANT_A, "session");
    const token = await signSessionToken(attacker, claims(TENANT_A, future()));
    expect(await verifySessionToken(good, token, { nowSec: Math.floor(Date.now() / 1000) })).toBeNull();
  });

  it("test_expired_token_does_not_verify", async () => {
    const key = await deriveTenantSessionKey(MASTER, TENANT_A, "session");
    const token = await signSessionToken(key, claims(TENANT_A, 2));
    expect(await verifySessionToken(key, token, { nowSec: 3 })).toBeNull();
  });
});

describe("M1 单元: 租户声明只用来选钥匙", () => {
  it("test_peek_reads_tenant_without_verifying", async () => {
    const attacker = await deriveTenantSessionKey("attacker-secret", TENANT_B, "session");
    const token = await signSessionToken(attacker, claims(TENANT_B, future()));
    // 未验签也能读出 gid——这正是"先读后用签名验"那一步的前提，
    // 所以它只能用来选钥匙，不能当身份事实。
    expect(peekTenantId(token)).toBe(TENANT_B);
  });

  it("test_peek_returns_null_for_garbage", () => {
    expect(peekTenantId("not-a-token")).toBeNull();
    expect(peekTenantId("a.b")).toBeNull();
    expect(peekTenantId("a.@@@.c")).toBeNull();
  });

  it("test_peek_returns_null_when_tenant_claim_is_missing", async () => {
    const key = await deriveTenantSessionKey(MASTER, TENANT_A, "session");
    const token = await signSessionToken(key, claims("", future()));
    expect(peekTenantId(token)).toBeNull();
  });
});
