import { Code } from "../../http/grpc";
import { ApiError, alreadyExists, internal, invalidArgument, notFound, permissionDenied, unauthenticated } from "../../http/errors";
import { hashPassword, verifyPassword } from "./password";
import * as store from "./store";
import { deriveTenantSessionKey, signSessionToken, verifySessionToken, type SessionClaims } from "./token";

/**
 * 身份/会话/账号的领域逻辑。
 *
 * 每一条校验消息、每一个错误码都照上游抄录（`api_authenticate.go` / `core_authenticate.go`），
 * 不做"顺手改好一点"：客户端与 SDK 会按这些字符串做分支判断。
 *
 * 全部入口都要求 `tenantId`——多租户不是可选参数，是这一层的形状（ECN-0001）。
 */

export interface TenantEnv {
  readonly db: D1Database;
  readonly masterSecret: string;
  readonly tenantId: string;
  readonly nowSec: number;
  readonly tokenExpirySec: number;
  readonly refreshTokenExpirySec: number;
}

/** 上游默认：`session.token_expiry_sec = 7200`、`refresh_token_expiry_sec = 604800`。 */
export const DEFAULT_TOKEN_EXPIRY_SEC = 7200;
export const DEFAULT_REFRESH_TOKEN_EXPIRY_SEC = 604800;

// 上游 api_authenticate.go 顶部三个正则的等价物。
const INVALID_CHARS = /[\u0000-\u001f\u007f\s]/u;
const INVALID_USERNAME_CHARS = /[\u0000-\u001f\u007f]/u;
const EMAIL_FORMAT = /^.+@.+\..+$/u;

const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).length;

function generateUsername(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length] ?? "a").join("");
}

function validateUsername(username: string): string {
  if (username === "") return generateUsername();
  if (INVALID_USERNAME_CHARS.test(username)) {
    throw invalidArgument("Username invalid, no spaces or control characters allowed.");
  }
  if (byteLength(username) > 128) {
    throw invalidArgument("Username invalid, must be 1-128 bytes.");
  }
  return username;
}

function validateProviderId(id: string, label: string, minBytes: number): void {
  if (id === "") throw invalidArgument(`${label} ID is required.`);
  if (INVALID_CHARS.test(id)) {
    throw invalidArgument(`${label} ID invalid, no spaces or control characters allowed.`);
  }
  const length = byteLength(id);
  if (length < minBytes || length > 128) {
    throw invalidArgument(`${label} ID invalid, must be ${minBytes}-128 bytes.`);
  }
}

export interface IdentityResult {
  readonly userId: string;
  readonly username: string;
  readonly created: boolean;
}

export interface SessionResult {
  readonly created: boolean;
  readonly token: string;
  readonly refreshToken: string;
}

async function issueSession(
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
  // 刷新令牌与访问令牌用**不同派生密钥**签名（上游用 refresh_encryption_key 做同一件事），
  // 于是一个令牌不可能被拿来当另一个用。
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

/** 已有账号解禁检查；上游对禁用账号返回 `403 User account banned.`。 */
function assertNotDisabled(user: store.UserRow): void {
  if (user.disable_time !== 0) {
    throw permissionDenied("User account banned.");
  }
}

function isUniqueViolation(error: unknown, columnHint: string): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && error.message.includes(columnHint);
}

export interface AuthenticateInput {
  readonly id: string;
  readonly vars?: Record<string, string>;
  readonly create: boolean;
  readonly username?: string;
}

async function authenticateWithIdentity(
  env: TenantEnv,
  provider: "device" | "custom",
  input: AuthenticateInput,
  username: string,
): Promise<IdentityResult> {
  const existingIdentity = await store.findIdentity(env.db, env.tenantId, provider, input.id);

  if (existingIdentity !== null) {
    const user = await store.findUserById(env.db, env.tenantId, existingIdentity.user_id);
    if (user === null) throw internal("Error finding user account.");
    assertNotDisabled(user);
    return { userId: user.id, username: user.username, created: false };
  }

  if (!input.create) throw notFound("User account not found.");

  const userId = crypto.randomUUID().toUpperCase();
  try {
    await store.createUserWithIdentity(env.db, {
      tenantId: env.tenantId,
      userId,
      username,
      now: env.nowSec,
      provider,
      providerId: input.id,
    });
  } catch (error) {
    if (isUniqueViolation(error, "username")) throw alreadyExists("Username is already in use.");
    if (isUniqueViolation(error, "user_identity")) {
      // 并发下另一个请求刚建了同一身份：按"已存在"处理，对齐上游不重复建号的意图。
      const raced = await store.findIdentity(env.db, env.tenantId, provider, input.id);
      if (raced !== null) {
        const user = await store.findUserById(env.db, env.tenantId, raced.user_id);
        if (user !== null) {
          return { userId: user.id, username: user.username, created: false };
        }
      }
    }
    throw internal("Error finding or creating user account.");
  }

  return { userId, username, created: true };
}

/**
 * 校验顺序照上游 `AuthenticateDevice` 抄：**先 ID、后用户名**。
 * 顺序可观测（两个参数都错时先报哪一个），所以不能凭喜好调换。
 */
export async function authenticateDevice(env: TenantEnv, input: AuthenticateInput): Promise<SessionResult> {
  validateProviderId(input.id, "Device", 10);
  const username = validateUsername(input.username ?? "");
  const identity = await authenticateWithIdentity(env, "device", input, username);
  return issueSession(env, { userId: identity.userId, username: identity.username, vars: input.vars }, identity.created);
}

export async function authenticateCustom(env: TenantEnv, input: AuthenticateInput): Promise<SessionResult> {
  validateProviderId(input.id, "Custom", 6);
  const username = validateUsername(input.username ?? "");
  const identity = await authenticateWithIdentity(env, "custom", input, username);
  return issueSession(env, { userId: identity.userId, username: identity.username, vars: input.vars }, identity.created);
}

export interface EmailInput {
  readonly email: string;
  readonly password: string;
  readonly vars?: Record<string, string>;
  readonly create: boolean;
  readonly username?: string;
  /** body 里 `account` 字段整体缺失时上游报的错与"邮箱为空"完全不同，所以要能区分。 */
  readonly accountMissing?: boolean;
}

/**
 * 邮箱认证。校验顺序逐条照上游 `AuthenticateEmail`：
 *   1. body 里没有 `account` → `Email address and password is required.`
 *   2. 邮箱非空时：非法字符 → 格式 → 长度
 *   3. 密码长度 < 8 → `Password must be at least 8 characters long.`
 *   4. 用户名：空 + 邮箱也为空 → 必须给用户名；给了就查非法字符与长度
 *   5. 邮箱为空 = 退化成"用户名 + 密码"登录，**永不允许创建账号**（create 被忽略）
 */
export async function authenticateEmail(env: TenantEnv, input: EmailInput): Promise<SessionResult> {
  if (input.accountMissing === true) {
    throw invalidArgument("Email address and password is required.");
  }

  let attemptUsernameLogin = false;
  if (input.email === "") {
    attemptUsernameLogin = true;
  } else if (INVALID_CHARS.test(input.email)) {
    throw invalidArgument("Invalid email address, no spaces or control characters allowed.");
  } else if (!EMAIL_FORMAT.test(input.email)) {
    throw invalidArgument("Invalid email address format.");
  } else {
    const emailLength = byteLength(input.email);
    if (emailLength < 10 || emailLength > 255) {
      throw invalidArgument("Invalid email address, must be 10-255 bytes.");
    }
  }

  if (input.password.length < 8) {
    throw invalidArgument("Password must be at least 8 characters long.");
  }

  const requestedUsername = input.username ?? "";
  if (attemptUsernameLogin) {
    if (requestedUsername === "") {
      throw invalidArgument("Username is required when email address is not supplied.");
    }
    if (INVALID_USERNAME_CHARS.test(requestedUsername)) {
      throw invalidArgument("Username invalid, no spaces or control characters allowed.");
    }
    if (byteLength(requestedUsername) > 128) {
      throw invalidArgument("Username invalid, must be 1-128 bytes.");
    }

    const user = await store.findUserByUsername(env.db, env.tenantId, requestedUsername);
    if (user === null) throw notFound("User account not found.");
    assertNotDisabled(user);
    if (user.password_hash === null || !(await verifyPassword(input.password, user.password_hash))) {
      throw unauthenticated("Invalid credentials.");
    }
    return issueSession(env, { userId: user.id, username: user.username, vars: input.vars }, false);
  }

  const username = validateUsername(requestedUsername);
  // 上游对 email 做小写归一后再入库与查询。
  const email = input.email.toLowerCase();

  const existing = await store.findUserByEmail(env.db, env.tenantId, email);
  if (existing !== null) {
    assertNotDisabled(existing);
    if (existing.password_hash === null || !(await verifyPassword(input.password, existing.password_hash))) {
      throw unauthenticated("Invalid credentials.");
    }
    return issueSession(env, { userId: existing.id, username: existing.username, vars: input.vars }, false);
  }

  if (!input.create) throw notFound("User account not found.");

  const userId = crypto.randomUUID().toUpperCase();
  const passwordHash = await hashPassword(input.password);
  try {
    await store.createUserWithIdentity(env.db, {
      tenantId: env.tenantId,
      userId,
      username,
      now: env.nowSec,
      email,
      passwordHash,
      provider: "email",
      providerId: email,
    });
  } catch (error) {
    if (isUniqueViolation(error, "username")) throw alreadyExists("Username is already in use.");
    if (isUniqueViolation(error, "email")) throw internal("Error finding or creating user account.");
    throw internal("Error finding or creating user account.");
  }

  return issueSession(env, { userId, username, vars: input.vars }, true);
}

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

  // 刷新令牌有效不等于账号还活着：上游在这里也要查一次账号（存在 + 未封禁）。
  const user = await store.findUserById(env.db, env.tenantId, claims.uid);
  if (user === null) throw notFound("User account not found.");
  assertNotDisabled(user);

  // 上游刷新时沿用同一个 token id 与签发时间，只换新的过期时间。
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
    if (claims.uid !== userId || claims.gid !== env.tenantId) throw invalidArgument("Session token invalid.");
    await store.revokeSession(env.db, claims.tid, env.tenantId, env.nowSec);
  }

  if (refreshToken !== "") {
    const refreshKey = await deriveTenantSessionKey(env.masterSecret, env.tenantId, "refresh");
    const claims = await verifySessionToken(refreshKey, refreshToken, { nowSec: env.nowSec });
    if (claims === null) throw invalidArgument("Refresh token invalid.");
    if (claims.uid !== userId || claims.gid !== env.tenantId) throw invalidArgument("Refresh token invalid.");
    await store.revokeSession(env.db, claims.tid, env.tenantId, env.nowSec);
  }

  if (token === "" && refreshToken === "") {
    await store.revokeSessionsForUser(env.db, env.tenantId, userId, env.nowSec);
  }
}

export interface ResolvedSession {
  readonly claims: SessionClaims;
  readonly user: store.UserRow;
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

export async function getAccount(
  env: TenantEnv,
  userId: string,
): Promise<{ user: store.UserRow; identities: store.IdentityRow[] }> {
  const user = await store.findUserById(env.db, env.tenantId, userId);
  // 消息取自上游 `ApiServer.GetAccount`（`core.GetAccount` 返回哨兵错误，api 层换成这句）。
  if (user === null) throw notFound("Account not found.");
  const identities = await store.findIdentitiesForUser(env.db, env.tenantId, userId);
  return { user, identities };
}

/** 只更新请求里**出现过的**字段；一个都没有时上游报 `No fields to update.`。 */
export async function updateAccount(
  env: TenantEnv,
  userId: string,
  patch: store.ProfilePatch,
): Promise<void> {
  if (patch.username !== undefined) {
    // 上游 api 层先查长度（1-128），core 层再查非法字符——两步的消息不同，顺序也不能换。
    const length = byteLength(patch.username);
    if (length < 1 || length > 128) {
      throw invalidArgument("Username invalid, must be 1-128 bytes.");
    }
    if (INVALID_USERNAME_CHARS.test(patch.username)) {
      throw invalidArgument("Username invalid, no spaces or control characters allowed.");
    }
  }

  if (Object.values(patch).every((value) => value === undefined)) {
    throw invalidArgument("No fields to update.");
  }

  const user = await store.findUserById(env.db, env.tenantId, userId);
  if (user === null) throw notFound("User account not found.");
  try {
    await store.updateProfile(env.db, env.tenantId, userId, patch, env.nowSec);
  } catch (error) {
    if (isUniqueViolation(error, "username")) throw alreadyExists("Username is already in use.");
    throw internal("Error updating user account.");
  }
}

export async function getUsers(
  env: TenantEnv,
  query: { ids: readonly string[]; usernames: readonly string[] },
): Promise<store.UserRow[]> {
  const byId = await store.findUsersByIds(env.db, env.tenantId, query.ids);
  const byUsername = await store.findUsersByUsernames(env.db, env.tenantId, query.usernames);
  const merged = new Map<string, store.UserRow>();
  for (const user of [...byId, ...byUsername]) {
    merged.set(user.id, user);
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** 供 wire 层复用：把 gRPC Code 值集中在这里，避免散落魔法数字。 */
export const GrpcCode = Code;
