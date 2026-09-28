/**
 * 控制台用户的用例层：建用户、重置密码、列表。
 *
 * 三条贯穿全文件的纪律，每一条都有对应的 DoD：
 *
 * 1. 授权判定必须发生在任何副作用之前。上游那份用例靠"撞到 nil 依赖就 panic"
 *    证明顺序（`TestAddUserRejectsInvalidACLBeforeSideEffects`）；这里把副作用
 *    收敛到一个端口（`ConsoleUserStore`）上，于是"顺序错了"表现为
 *    "端口被调用过"——可以用计数断言，而不是靠 panic。
 * 2. 重置密码前先读目标的 ACL 并授权。上游用 `SELECT ... FOR UPDATE` 把目标行
 *    锁住；D1 没有行锁，本项目把"读 ACL → 判定 → 写"放在这一条串行路径上
 *    （差异登记在 ECN-0014 偏差 3）。
 * 3. 校验顺序与文案逐字对齐上游：顺序错了文案就会错，而客户端按文案分支。
 *
 * 契约源（机器可读）：
 * 契约源: server/console_user.go::AddUser
 * 契约源: server/console_user.go::ResetUserPassword
 * 契约源: server/console_user.go::ListUsers
 *
 * REQ-0001-021
 */

import { failedPrecondition, internal, invalidArgument, notFound } from "../../../http/errors";
import { hashPassword } from "../../identity/password";
import { sha256Hex } from "../../tenancy/store";
import {
  permissionFromAcl,
  permissionFromJson,
  permissionToJson,
  type AclMap,
  type Permission,
} from "../acl/permission";
import { validateConsoleUserACLGrant, validateConsoleUserTargetACL } from "./policy";

/** 上游 `server/console_user.go` 顶部那三条正则，逐条照搬。 */
const USERNAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._].*[a-zA-Z0-9]$/;
const USERNAME_RULE =
  "Username must be 3-20 long sequence of alphanumeric characters _ or . and cannot start and end with _ or .";
const EMAIL_REGEX = /^.+@.+\..+$/;
/** POSIX `[[:cntrl:]]` / `[[:space:]]` 的等价写法（Go 用的是两者取并）。 */
const INVALID_CHARS_REGEX = /[\p{Cc}\s]+/u;

/** 一次性 code 与临时口令的哈希轮数：内部状态，取一个够用又不拖慢测试的值。 */
export const CONSOLE_PASSWORD_ITERATIONS = 10_000;
export const CONSOLE_RESET_CODE_EXPIRY_SEC = 3600;
const RESET_MAX_ATTEMPTS = 3;

export interface ConsoleUserRecord {
  readonly id: string;
  readonly username: string;
  readonly email: string;
  readonly aclJson: string;
  readonly mfaRequired: boolean;
  readonly mfaEnabled: boolean;
  readonly createTime: number;
  readonly updateTime: number;
  /** 上游 `create_time != update_time`：这一次写入更新的是已存在的用户。 */
  readonly updated: boolean;
}

export interface NewConsoleUser {
  readonly id: string;
  readonly username: string;
  readonly email: string;
  readonly aclJson: string;
  readonly mfaRequired: boolean;
  readonly now: number;
}

export interface PasswordPatch {
  readonly passwordHash: string;
  readonly codeHash: string;
  readonly codeExpiry: number;
}

export interface ConsoleAuditEntry {
  readonly action: "CREATE" | "UPDATE";
  readonly message: string;
  readonly metadata: string;
  readonly now: number;
}

/**
 * 副作用端口。只有这个接口会碰数据库，所以"授权先于副作用"这条可以被计数证明。
 */
export interface ConsoleUserStore {
  insertUser(user: NewConsoleUser): Promise<ConsoleUserRecord>;
  listUsers(): Promise<readonly ConsoleUserRecord[]>;
  /** 返回目标的 ACL JSON；用户不存在回 `null`。 */
  readUserAcl(username: string): Promise<string | null>;
  /** 写回口令与一次性 code；目标不存在回 `false`。 */
  updatePassword(username: string, patch: PasswordPatch, now: number): Promise<boolean>;
  writeAudit(entry: ConsoleAuditEntry): Promise<void>;
}

/**
 * D1 在写冲突时抛的可重试错误（上游那边是 Postgres 的 serialization failure）。
 *
 * 只有这一个错误会被重试：其余错误一律按 Internal 上报，重试一个坏查询只会让它更慢。
 */
export class SerializationFailure extends Error {
  constructor(message = "console user write conflict") {
    super(message);
    this.name = "SerializationFailure";
  }
}

export interface AddConsoleUserInput {
  readonly creatorUsername: string;
  readonly creatorPermission: Permission;
  /** 上游 `config.GetConsole().Username`：这个用户名与 `admin` 一样不允许被创建。 */
  readonly reservedUsername: string;
  readonly username: string;
  readonly email: string;
  readonly acl: AclMap;
  readonly mfaRequired: boolean;
  readonly now: number;
}

/**
 * 上游 `AddUser` 的校验顺序（每一步都要与上游同序，否则文案会错）：
 * 改自己 → 用户名为空 → 用户名格式 → 保留名 → 邮箱为空 → 邮箱格式 → ACL 授权 → 副作用。
 */
export async function addConsoleUser(
  store: ConsoleUserStore,
  input: AddConsoleUserInput,
): Promise<ConsoleUserRecord> {
  if (input.creatorUsername === input.username) {
    throw failedPrecondition("Cannot change own configuration");
  }
  if (input.username === "") throw invalidArgument("Username is required");
  if (input.username.length < 3 || input.username.length > 20 || !USERNAME_REGEX.test(input.username)) {
    throw invalidArgument(USERNAME_RULE);
  }
  const username = input.username.toLowerCase();
  if (username === "admin" || username === input.reservedUsername) {
    throw invalidArgument("Username cannot be the console configured username");
  }
  if (input.email === "") throw invalidArgument("Email is required");
  if (
    input.email.length < 3 ||
    input.email.length > 254 ||
    !EMAIL_REGEX.test(input.email) ||
    INVALID_CHARS_REGEX.test(input.email)
  ) {
    throw invalidArgument("Not a valid email address");
  }

  const requestedRole = permissionFromAcl(input.acl);
  validateConsoleUserACLGrant(input.creatorPermission, requestedRole);

  // —— 以下是副作用，只有上面的授权全部通过才会到达 ——
  const record = await store.insertUser({
    id: crypto.randomUUID(),
    username,
    email: input.email.toLowerCase(),
    aclJson: permissionToJson(requestedRole),
    mfaRequired: input.mfaRequired,
    now: input.now,
  });
  await store.writeAudit({
    action: "CREATE",
    message: "Created console user.",
    metadata: JSON.stringify({ username }),
    now: input.now,
  });
  return record;
}

export interface ResetPasswordInput {
  readonly callerPermission: Permission;
  readonly targetUsername: string;
  readonly now: number;
  readonly codeExpirySec?: number;
  readonly passwordHashIterations?: number;
}

export interface ResetPasswordResult {
  /** 一次性 code：调用方拿它去设置新口令（上游把它做成控制台 JWT）。 */
  readonly code: string;
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 上游 `ResetUserPassword`：读目标 ACL（上游带 `FOR UPDATE`）→ 授权 → 生成临时口令
 * 与一次性 code → 更新 `console_user` → 返回 code。
 *
 * 三条状态码必须分清：目标不存在是 `NotFound`、目标权限超出调用者是 `PermissionDenied`、
 * 目标 ACL 读不出来（畸形 JSON）是 `Internal`——畸形数据是服务端自己的问题，
 * 报 403 会让运维以为"权限不够"而查错方向。
 */
export async function resetConsoleUserPassword(
  store: ConsoleUserStore,
  input: ResetPasswordInput,
): Promise<ResetPasswordResult> {
  const failure = "An error occurred while trying to reset the user password.";
  for (let attempt = 1; attempt <= RESET_MAX_ATTEMPTS; attempt += 1) {
    let aclJson: string | null;
    try {
      aclJson = await store.readUserAcl(input.targetUsername);
    } catch (error) {
      if (error instanceof SerializationFailure && attempt < RESET_MAX_ATTEMPTS) continue;
      throw internal(failure);
    }
    if (aclJson === null) throw notFound("User not found.");
    let targetRole: Permission;
    try {
      targetRole = permissionFromJson(aclJson);
    } catch {
      throw internal(failure);
    }
    validateConsoleUserTargetACL(input.callerPermission, targetRole);

    const passwordHash = await hashPassword(
      randomSecret(),
      input.passwordHashIterations ?? CONSOLE_PASSWORD_ITERATIONS,
    );
    const code = randomSecret();
    const updated = await store.updatePassword(
      input.targetUsername,
      {
        passwordHash,
        codeHash: await sha256Hex(code),
        codeExpiry: input.now + (input.codeExpirySec ?? CONSOLE_RESET_CODE_EXPIRY_SEC),
      },
      input.now,
    );
    if (!updated) throw notFound("User not found.");
    await store.writeAudit({
      action: "UPDATE",
      message: "Reset console user password.",
      metadata: JSON.stringify({ username: input.targetUsername }),
      now: input.now,
    });
    return { code };
  }
  throw internal(failure);
}

export function listConsoleUsers(store: ConsoleUserStore): Promise<readonly ConsoleUserRecord[]> {
  return store.listUsers();
}
