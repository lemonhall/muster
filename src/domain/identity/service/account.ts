/**
 * 账号资料与用户查询。
 *
 * 错误消息取自上游 `ApiServer.GetAccount` / `ApiServer.UpdateAccount` / `GetUsers`：
 * `core` 层返回哨兵错误，api 层换成这些字符串。
 */

import { alreadyExists, internal, invalidArgument, notFound } from "../../../http/errors";
import * as store from "../store";
import type { TenantEnv } from "./types";
import { byteLength, isUniqueViolation, usesInvalidUsernameChars } from "./validate";

export async function getAccount(
  env: TenantEnv,
  userId: string,
): Promise<{ user: store.UserRow; identities: store.IdentityRow[] }> {
  const user = await store.findUserById(env.db, env.tenantId, userId);
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
    if (usesInvalidUsernameChars(patch.username)) {
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
