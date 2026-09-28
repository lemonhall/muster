/**
 * Google 认证的账号侧：一个可信档案 → 一个会话。
 *
 * 上游是 `core_authenticate.go::AuthenticateGoogle`，它做四件事，这里逐条对齐：
 *   1. 校验失败一律 `Unauthenticated "Could not authenticate Google profile."`；
 *   2. 已存在的账号：禁用 → `PermissionDenied "User account banned."`，
 *      并在 `display_name` / `avatar_url` 为空时用 Google 的资料**回填**
 *      （回填失败只记日志，不打断登录）；
 *   3. 不存在 + `create=false` → `NotFound "User account not found."`；允许创建时，
 *      用户名冲突是 `AlreadyExists "Username is already in use."`，
 *      身份冲突是 `Internal "Error finding or creating user account."`；
 *   4. Google 带回了邮箱就写进账号（撞唯一键只警告、不失败）。
 *
 * 名字与头像的**长度上限**照抄：超长就整条丢弃（`display_name` 255、`avatar_url` 512），
 * 不是截断——截断会把一个错误的资料写成"看起来对"的资料。
 *
 * 第 4 条的形状值得说明：本项目把"用户 + 身份"用一个 batch 原子写入（没有"有用户没身份"
 * 的中间态），所以邮箱是**建号之后**再单独写一次，与上游同序，唯一冲突也只警告。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_authenticate.go::AuthenticateGoogle
 * 契约源: server/core_authenticate.go::AuthenticateGoogle
 */

import { alreadyExists, internal, invalidArgument, notFound, unauthenticated } from "../../../http/errors";
import * as store from "../../identity/store";
import { issueSession } from "../../identity/service/session";
import type { SessionResult, TenantEnv } from "../../identity/service/types";
import { assertNotDisabled, isUniqueViolation, validateUsername } from "../../identity/service/validate";
import type { GoogleAuthCodeConfig } from "./auth-code";
import type { GoogleCertSource } from "./certs";
import { checkGoogleToken } from "./token";

/** 上游 `users.google_id` 这一列在本项目里是 `user_identity` 的一个 provider。 */
export const GOOGLE_PROVIDER = "google";

const MAX_DISPLAY_NAME = 255;
const MAX_AVATAR_URL = 512;

export interface GoogleDeps {
  readonly clientIds: readonly string[];
  readonly certs: GoogleCertSource;
  readonly authCode?: GoogleAuthCodeConfig | undefined;
}

export interface GoogleAuthInput {
  readonly token: string;
  readonly username?: string | undefined;
  readonly create: boolean;
  readonly vars?: Record<string, string> | undefined;
}

export async function authenticateGoogle(
  env: TenantEnv,
  input: GoogleAuthInput,
  deps: GoogleDeps,
): Promise<SessionResult> {
  // 上游 api 层的顺序：先"有没有 token"，再用户名合法性，最后才去校验 token。
  if (input.token === "") throw invalidArgument("Google access token is required.");
  const username = validateUsername(input.username ?? "");

  const profile = await checkGoogleToken({
    idToken: input.token,
    clientIds: deps.clientIds,
    certs: deps.certs,
    nowSec: env.nowSec,
    ...(deps.authCode === undefined ? {} : { authCode: deps.authCode }),
  }).catch(() => {
    // 细节（iss/aud/azp/签名/证书）不进响应体：上游也只回这一句。
    throw unauthenticated("Could not authenticate Google profile.");
  });

  const displayName = capped(profile.name, MAX_DISPLAY_NAME);
  const avatarUrl = capped(profile.picture, MAX_AVATAR_URL);

  const identity = await store.findIdentity(env.db, env.tenantId, GOOGLE_PROVIDER, profile.googleId);
  if (identity !== null) {
    const user = await store.findUserById(env.db, env.tenantId, identity.user_id);
    if (user === null) throw internal("Error finding user account.");
    assertNotDisabled(user);
    await backfillProfile(env, user, displayName, avatarUrl);
    return issueSession(env, { userId: user.id, username: user.username, vars: input.vars }, false);
  }

  if (!input.create) throw notFound("User account not found.");

  const userId = crypto.randomUUID().toUpperCase();
  try {
    await store.createUserWithIdentity(env.db, {
      tenantId: env.tenantId,
      userId,
      username,
      now: env.nowSec,
      displayName,
      avatarUrl,
      provider: GOOGLE_PROVIDER,
      providerId: profile.googleId,
    });
  } catch (error) {
    if (isUniqueViolation(error, "username")) throw alreadyExists("Username is already in use.");
    throw internal("Error finding or creating user account.");
  }

  await importEmail(env, userId, profile.email);
  return issueSession(env, { userId, username, vars: input.vars }, true);
}

/** 上游：`display_name` / `avatar_url` 为空且 Google 给了值时才回填，失败不打断登录。 */
async function backfillProfile(
  env: TenantEnv,
  user: store.UserRow,
  displayName: string,
  avatarUrl: string,
): Promise<void> {
  const patch: store.ProfilePatch = {
    ...(user.display_name === "" && displayName !== "" ? { display_name: displayName } : {}),
    ...(user.avatar_url === "" && avatarUrl !== "" ? { avatar_url: avatarUrl } : {}),
  };
  if (patch.display_name === undefined && patch.avatar_url === undefined) return;
  await store.updateProfile(env.db, env.tenantId, user.id, patch, env.nowSec).catch(() => undefined);
}

/**
 * 邮箱导入。撞别人已用的邮箱只当"没导入"（上游那条 Warn），其它错误才是 500。
 * 顺序也是上游的：先建账号、再导邮箱。
 */
async function importEmail(env: TenantEnv, userId: string, email: string): Promise<void> {
  if (email === "") return;
  try {
    await store.setUserEmail(env.db, env.tenantId, userId, email);
  } catch (error) {
    if (isUniqueViolation(error, "email")) return;
    throw internal("Error importing google account email.");
  }
}

/** 超长即整条丢弃（上游把值置空），不是截断。 */
function capped(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : "";
}
