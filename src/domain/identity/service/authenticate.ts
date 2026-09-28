/**
 * 认证：设备 / 自定义 / 邮箱。
 *
 * 校验顺序照上游逐条抄，**顺序本身可观测**（两个参数都错时先报哪一个），所以不能凭
 * 喜好调换：设备是"先 ID、后用户名"，邮箱是"account 缺失 → 邮箱字符/格式/长度 →
 * 密码长度 → 用户名"。
 */

import { alreadyExists, internal, invalidArgument, notFound, unauthenticated } from "../../../http/errors";
import { hashPassword, verifyPassword } from "../password";
import * as store from "../store";
import { issueSession } from "./session";
import type { AuthenticateInput, EmailInput, IdentityResult, SessionResult, TenantEnv } from "./types";
import {
  assertNotDisabled,
  byteLength,
  isUniqueViolation,
  looksLikeEmail,
  usesInvalidChars,
  usesInvalidUsernameChars,
  validateProviderId,
  validateUsername,
} from "./validate";

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
 * 设备认证：校验顺序照上游 `AuthenticateDevice` 抄：**先 ID、后用户名**。
 */
export async function authenticateDevice(env: TenantEnv, input: AuthenticateInput): Promise<SessionResult> {
  validateProviderId(input.id, "Device", 10);
  const username = validateUsername(input.username ?? "");
  const identity = await authenticateWithIdentity(env, "device", input, username);
  return issueSession(
    env,
    { userId: identity.userId, username: identity.username, vars: input.vars },
    identity.created,
  );
}

export async function authenticateCustom(env: TenantEnv, input: AuthenticateInput): Promise<SessionResult> {
  validateProviderId(input.id, "Custom", 6);
  const username = validateUsername(input.username ?? "");
  const identity = await authenticateWithIdentity(env, "custom", input, username);
  return issueSession(
    env,
    { userId: identity.userId, username: identity.username, vars: input.vars },
    identity.created,
  );
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
  } else if (usesInvalidChars(input.email)) {
    throw invalidArgument("Invalid email address, no spaces or control characters allowed.");
  } else if (!looksLikeEmail(input.email)) {
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
    if (usesInvalidUsernameChars(requestedUsername)) {
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
