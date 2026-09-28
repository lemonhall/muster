import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { toBase64Url } from "../../../src/domain/base64url";
import {
  MATCH_TOKEN_TTL_SECONDS,
  newRelayMatchId,
  signMatchToken,
  verifyMatchToken,
} from "../../../src/domain/match/token";
import type { Bindings } from "../../../src/env";
import { TENANT_A, TENANT_B } from "../../helpers/tenants";

/**
 * M7 契约：对局加入令牌（`matchmaker_matched.token` → `match_join` 的那条路）。
 *
 * 上游签的是 HS256 JWT，三件事在客户端可见：
 *
 * 1. `mid` 的 node 段是**空**的（`<uuid>.`）——它是"随机新建的中继对局"的标记；
 * 2. 有效期 30 秒；
 * 3. 只认 HS256：`alg: none` 这类"自己声称不用签名"的令牌必须被拒，而不是
 *    降级成"没签名也认"。
 *
 * 额外的本项目规矩（ECN-0001）：签名密钥按租户派生，所以**一个租户的令牌在
 * 另一个租户上验不过**。上游是单租户部署，没有这条，但多租户下它是安全边界。
 *
 * 契约源（机器可读）：
 * 契约源: server/matchmaker.go::LocalMatchmaker.Process
 * 契约源: server/pipeline_match.go::Pipeline.matchJoin
 *
 * REQ-0001-018
 */

const bindings = env as Bindings;
const NOW = 1_700_000_000;

/** 手搓一个 JWT（只给测试用）：header 与 payload 由调用方决定，签名段可空。 */
function forge(header: unknown, payload: unknown, signature = ""): string {
  return `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}.${signature}`;
}

describe("M7 契约: 对局令牌", () => {
  it("test_a_signed_token_round_trips_with_a_thirty_second_expiry", async () => {
    const mid = newRelayMatchId("123e4567-e89b-42d3-a456-426614174000");
    const token = await signMatchToken(bindings, TENANT_A, mid, NOW);

    expect(mid.endsWith(".")).toBe(true);
    expect(await verifyMatchToken(bindings, TENANT_A, token, NOW)).toEqual({
      mid,
      exp: NOW + MATCH_TOKEN_TTL_SECONDS,
    });
    // 恰好到期的前一秒还有效；到点即失效（`exp <= now` 就是过期）。
    expect(await verifyMatchToken(bindings, TENANT_A, token, NOW + 29)).not.toBeNull();
    expect(await verifyMatchToken(bindings, TENANT_A, token, NOW + 30)).toBeNull();
  });

  it("test_hs256_is_the_only_accepted_algorithm", async () => {
    const mid = newRelayMatchId("123e4567-e89b-42d3-a456-426614174000");
    // `alg: none` + 空签名：上游那种"先看 alg 再决定要不要验签"的实现会中招。
    const unsigned = forge(
      { alg: "none", typ: "JWT" },
      { mid, exp: NOW + MATCH_TOKEN_TTL_SECONDS },
    );
    expect(await verifyMatchToken(bindings, TENANT_A, unsigned, NOW)).toBeNull();
  });

  it("test_a_tampered_payload_no_longer_verifies", async () => {
    const token = await signMatchToken(
      bindings,
      TENANT_A,
      newRelayMatchId("123e4567-e89b-42d3-a456-426614174000"),
      NOW,
    );
    const [, , signature] = token.split(".") as [string, string, string];
    const tampered = forge(
      { alg: "HS256", typ: "JWT" },
      { mid: newRelayMatchId("00000000-0000-4000-8000-000000000000"), exp: NOW + 999 },
      signature,
    );
    expect(await verifyMatchToken(bindings, TENANT_A, tampered, NOW)).toBeNull();
  });

  it("test_a_token_signed_for_one_tenant_never_verifies_on_another", async () => {
    const mid = newRelayMatchId("123e4567-e89b-42d3-a456-426614174000");
    const token = await signMatchToken(bindings, TENANT_A, mid, NOW);
    expect(await verifyMatchToken(bindings, TENANT_B, token, NOW)).toBeNull();
  });

  it("test_structural_damage_is_a_rejection_not_an_exception", async () => {
    for (const bad of ["", "a.b", "a.b.c.d", "!!.!!.!!"]) {
      expect(await verifyMatchToken(bindings, TENANT_A, bad, NOW)).toBeNull();
    }
  });

  it("test_a_missing_or_expired_claim_is_rejected", async () => {
    // 已过期的载荷即使签名正确也不认。
    const expired = await signMatchToken(
      bindings,
      TENANT_A,
      newRelayMatchId("123e4567-e89b-42d3-a456-426614174000"),
      NOW - 60,
    );
    expect(await verifyMatchToken(bindings, TENANT_A, expired, NOW)).toBeNull();

    // `mid` 是空串的令牌同样不认：它指不到任何一场对局。
    const emptyMid = await signMatchToken(bindings, TENANT_A, "", NOW);
    expect(await verifyMatchToken(bindings, TENANT_A, emptyMid, NOW)).toBeNull();
  });
});
