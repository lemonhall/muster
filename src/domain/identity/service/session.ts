/**
 * 会话：签发、刷新、登出、Bearer 解析。
 *
 * 访问令牌与刷新令牌用**不同派生密钥**签名（上游用 refresh_encryption_key 做同一件事），
 * 于是一个令牌不可能被拿来当另一个用。
 */

import { invalidArgument, notFound, unauthenticated } from "../../../http/errors";
import * as store from "../store";
import { deriveTenantSessionKey, signSessionToken, verifySessionToken, type SessionClaims } from "../token";
import type { ResolvedSession, SessionResult, TenantEnv } from "./types";
import { assertNotDisabled } from "./validate";

export async function issueSession(
  env: TenantEnv,
  identity: { userId: string; username: string; vars: Record<string, string> | undefined },
  created: boolean,
  reuse?: { tokenId: string; issuedAt: number },
): Promise<SessionResult> {
  const tokenId = reuse?.tokenId ?? crypto.randomUUID().toUpperCase();
  const issuedAt = reuse?.issuedAt ?? env.nowSec;
  const exp = env.nowSec + env.tokenExpirySec;
  const refreshExp = env.nowSec + env.refreshTokenExpirySec;

  const sessionKey = await deriveTenantSessionKey(env.masterSecret, env.tenantId, "session");
  const refreshKey = await deriveTenantSessionKey(env.masterSecret, env.tenantId, "refresh");
  const claims: SessionClaims = {
    tid: tokenId,
    uid: identity.userId,
    usn: identity.username,
    gid: env.tenantId,
    ...(identity.vars === undefined ? {} : { vrs: identity.vars }),
    iat: issuedAt,
    exp,
  };

  const token = await signSessionToken(sessionKey, claims);
  const refreshToken = await signSessionToken(refreshKey, { ...claims, exp: refreshExp });

  await store.insertSession(env.db, {
    tokenId,
    tenantId: env.tenantId,
    userId: identity.userId,
    exp,
    refreshExp,
    now: env.nowSec,
  });

  return { created, token, refreshToken };
}

/**
 * 刷新会话。
 *
 * 刷新令牌有效不等于账号还活着：上游在这里也要查一次账号（存在 + 未封禁）。
 * 刷新时**沿用同一个 token id 与签发时间**，只换新的过期时间。
 */
export async function refreshSession(
  env: TenantEnv,
  refreshToken: string,
  vars: Record<string, string> | undefined,
): Promise<SessionResult> {
  if (refreshToken === "") throw invalidArgument("Refresh token is required.");

  const refreshKey = await deriveTenantSessionKey(env.masterSecret, env.tenantId, "refresh");
  const claims = await verifySessionToken(refreshKey, refreshToken, { nowSec: env.nowSec });
  if (claims === null) throw unauthenticated("Refresh token invalid or expired.");
  if (claims.gid !== env.tenantId) throw unauthenticated("Refresh token invalid or expired.");

  const session = await store.findSession(env.db, claims.tid, env.tenantId);
  if (session === null || session.revoked_at !== 0 || session.tenant_id !== env.tenantId) {
    throw unauthenticated("Refresh token invalid or expired.");
  }

  const user = await store.findUserById(env.db, env.tenantId, claims.uid);
  if (user === null) throw notFound("User account not found.");
  assertNotDisabled(user);

  return issueSession(
    env,
    { userId: claims.uid, username: user.username, vars: vars ?? claims.vrs },
    false,
    { tokenId: claims.tid, issuedAt: claims.iat },
  );
}

/**
 * 登出。
 *
 * 三种语义，逐条照上游 `SessionLogout`：
 * 1. 给了 access token → 吊销该 token_id；
 * 2. 给了 refresh token → 吊销该 token_id；
 * 3. **两个都不给 → 吊销该用户的全部会话**（上游走 `sessionCache.RemoveAll`），
 *    不是报错——所以 `{}` 是一个合法且杀伤力最大的请求体。
 */
export async function logout(
  env: TenantEnv,
  userId: string,
  input: { token?: string; refreshToken?: string },
): Promise<void> {
  const token = input.token ?? "";
  const refreshToken = input.refreshToken ?? "";

  if (token !== "") {
    const sessionKey = await deriveTenantSessionKey(env.masterSecret, env.tenantId, "session");
    const claims = await verifySessionToken(sessionKey, token, { nowSec: env.nowSec });
    if (claims === null) throw invalidArgument("Session token invalid.");
    if (claims.uid !== userId || claims.gid !== env.tenantId) {
      throw invalidArgument("Session token invalid.");
    }
    await store.revokeSession(env.db, claims.tid, env.tenantId, env.nowSec);
  }

  if (refreshToken !== "") {
    const refreshKey = await deriveTenantSessionKey(env.masterSecret, env.tenantId, "refresh");
    const claims = await verifySessionToken(refreshKey, refreshToken, { nowSec: env.nowSec });
    if (claims === null) throw invalidArgument("Refresh token invalid.");
    if (claims.uid !== userId || claims.gid !== env.tenantId) {
      throw invalidArgument("Refresh token invalid.");
    }
    await store.revokeSession(env.db, claims.tid, env.tenantId, env.nowSec);
  }

  if (token === "" && refreshToken === "") {
    await store.revokeSessionsForUser(env.db, env.tenantId, userId, env.nowSec);
  }
}

/** Bearer 令牌 → 会话上下文。签名、租户、吊销状态、账号状态四道关都要过。 */
export async function resolveBearerSession(env: TenantEnv, token: string): Promise<ResolvedSession> {
  // 这两条消息**没有**结尾句号，与上游 securityInterceptorFunc 逐字一致。
  if (token === "") throw unauthenticated("Auth token required");

  const sessionKey = await deriveTenantSessionKey(env.masterSecret, env.tenantId, "session");
  const claims = await verifySessionToken(sessionKey, token, { nowSec: env.nowSec });
  // 令牌里的租户与请求租户不一致 = 拿 A 游戏的令牌打 B 游戏，一律当作无效令牌。
  if (claims === null || claims.gid !== env.tenantId) throw unauthenticated("Auth token invalid");

  const session = await store.findSession(env.db, claims.tid, env.tenantId);
  if (session === null || session.revoked_at !== 0 || session.tenant_id !== env.tenantId) {
    throw unauthenticated("Auth token invalid");
  }

  const user = await store.findUserById(env.db, env.tenantId, claims.uid);
  if (user === null) throw unauthenticated("Auth token invalid");
  assertNotDisabled(user);

  return { claims, user };
}
