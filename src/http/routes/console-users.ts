/**
 * 控制台用户的 3 条端点：
 *
 *   POST /v2/console/user                          建（或更新）一个控制台用户
 *   POST /v2/console/user/{username}/reset/password 重置口令，回一次性 code
 *   GET  /v2/console/user                          列出本租户的控制台用户
 *
 * **鉴权是 tenant server key**（`handleServerKey`），不是上游的控制台 JWT——
 * 这是本项目最显眼的一处偏差，理由与后果写在 ECN-0014 偏差 1。
 * 由此推出一条实现选择：server key 持有者就是租户的根，所以调用者的权限是 `Admin()`。
 * 上游那条"不能改自己"的检查在这条路径上永远不成立（管理面没有"自己"这个身份），
 * 但它仍然留在用例层里，因为它是被搬运的规则之一。
 *
 * 上游路径 `{username}/reset/password` 与计划里写的 `{username}/password-reset`
 * **两条都注册**：前者是上游控制台的路径，后者是 v4 计划冻结的 DoD 措辞。
 *
 * 契约源（机器可读）：
 * 契约源: console/console.proto::Console/AddUser
 * 契约源: console/console.proto::Console/ResetUserPassword
 * 契约源: console/console.proto::Console/ListUsers
 *
 * REQ-0001-021
 */

import { adminPermission, type PermissionFlags } from "../../domain/console/acl/permission";
import {
  addConsoleUser,
  issueConsoleUserCode,
  listConsoleUsers,
  resetConsoleUserPassword,
} from "../../domain/console/users/service";
import { d1ConsoleUserStore } from "../../domain/console/users/store";
import { consoleUserBody, consoleUserListBody } from "../../wire/console";
import { asObject, json, optionalBool, optionalString, parseBody, readField } from "../body";
import { invalidArgument } from "../errors";
import type { AuthedContext, Router } from "../router";

/** 上游 `config.GetConsole().Username` 的位置：这个用户名不允许被创建。 */
const DEFAULT_RESERVED_USERNAME = "admin";

type AclInput = Record<string, Partial<PermissionFlags>>;

function booleanField(entry: Record<string, unknown>, key: string, resource: string): boolean {
  const value = entry[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    throw invalidArgument(`Invalid acl: ${resource}.${key} must be a boolean.`);
  }
  return value;
}

/**
 * `acl` 是 `map<string, Permissions>`。缺省（`null` / 不写）与空表都是"没有任何权限"，
 * 于是**会被授权规则以"User must have at least some permissions."拒掉**——
 * 与上游把 `nil` 映射进 `acl.New(nil)` 得到 `None()` 的路径完全一致。
 */
function parseAcl(body: Record<string, unknown>): AclInput {
  const raw = readField(body, "acl");
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidArgument("Invalid acl: expected an object.");
  }
  const out: AclInput = {};
  for (const [resource, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw invalidArgument(`Invalid acl: ${resource} must be an object.`);
    }
    const entry = value as Record<string, unknown>;
    out[resource] = {
      read: booleanField(entry, "read", resource),
      write: booleanField(entry, "write", resource),
      delete: booleanField(entry, "delete", resource),
    };
  }
  return out;
}

function nowOf(context: AuthedContext): number {
  return context.tenantEnv.nowSec;
}

async function createUser(context: AuthedContext): Promise<Response> {
  const body = asObject(await parseBody(context.request), "request body");
  const store = d1ConsoleUserStore(context.env.DB, context.tenantEnv.tenantId);
  const reservedUsername = context.env.CONSOLE_USERNAME ?? DEFAULT_RESERVED_USERNAME;
  const user = await addConsoleUser(store, {
    // 管理面没有"自己的用户名"（ECN-0014 偏差 1），这条检查在这条路径上恒不成立。
    creatorUsername: "",
    creatorPermission: adminPermission(),
    reservedUsername,
    username: optionalString(body, "username") ?? "",
    email: optionalString(body, "email") ?? "",
    acl: parseAcl(body),
    mfaRequired: optionalBool(body, "mfa_required") ?? false,
    now: nowOf(context),
  });
  const issued = await issueConsoleUserCode(store, { username: user.username, now: nowOf(context) });
  // 上游 `AddUserResponse{user, token}`：`token` 在这里是一枚一次性 code（见偏差 1）。
  return json({ user: consoleUserBody(user), token: issued.code });
}

async function resetPassword(context: AuthedContext): Promise<Response> {
  const store = d1ConsoleUserStore(context.env.DB, context.tenantEnv.tenantId);
  const result = await resetConsoleUserPassword(store, {
    callerPermission: adminPermission(),
    targetUsername: context.params.username ?? "",
    now: nowOf(context),
  });
  return json({ code: result.code });
}

async function listUsers(context: AuthedContext): Promise<Response> {
  const store = d1ConsoleUserStore(context.env.DB, context.tenantEnv.tenantId);
  return json(consoleUserListBody(await listConsoleUsers(store)));
}

export function registerConsoleUserRoutes(router: Router): void {
  router.handleServerKey("POST", "/v2/console/user", createUser);
  router.handleServerKey("POST", "/v2/console/user/{username}/reset/password", resetPassword);
  router.handleServerKey("POST", "/v2/console/user/{username}/password-reset", resetPassword);
  router.handleServerKey("GET", "/v2/console/user", listUsers);
}
