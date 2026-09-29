import { describe, expect, it } from "vitest";

import { Code } from "../../../src/http/grpc";
import {
  PermissionLevel,
  aclOf,
  adminPermission,
  compose,
  newPermissionFromName,
  permissionFromJson,
  type Permission,
} from "../../../src/domain/console/acl/permission";
import { addConsoleUser, type AddConsoleUserInput } from "../../../src/domain/console/users/service";
import { fakeConsoleUserStore, statusOf } from "../../helpers/console-users";

/**
 * M9 单元测试：越权 / 空 ACL 必须在**任何副作用之前**被拒
 * （覆盖矩阵第 169 条，搬运 `console_user_add_acl_test.go::TestAddUserRejectsInvalidACLBeforeSideEffects`）。
 *
 * 上游那份测试的证明方式是"撞到 nil 依赖就 panic"——它测的是**顺序**，
 * 而不是"报错信息看起来对"。本项目的等价物是**副作用计数**：
 * `inserts` 与 `audits` 都必须是 0。只有状态码为 `InvalidArgument` 而计数非 0，
 * 就说明我们把"先写后验"写成了默认行为（那正是上游那条用例要防的漏洞）。
 *
 * 溯源: server/console_user_add_acl_test.go::TestAddUserRejectsInvalidACLBeforeSideEffects
 *
 * REQ-0001-021
 */

const { Read, Write } = PermissionLevel;

const CREATOR = "limitedoperator";
const NOW = 1_800_000_000;

/** 调用者只有 ACCOUNT 的 write——低于 admin，所以"发 admin"必然越权。 */
const limited = newPermissionFromName("ACCOUNT", Write);
/** 调用者拿全 ACCOUNT 的读写：用来验证"合法的授权能走完"。 */
const fullAccount = compose(limited, newPermissionFromName("ACCOUNT", Read));

function input(
  acl: AddConsoleUserInput["acl"],
  creatorPermission: Permission = limited,
): AddConsoleUserInput {
  return {
    creatorUsername: CREATOR,
    creatorPermission,
    reservedUsername: "configuredadmin",
    username: "invaliduser",
    email: "invaliduser@example.invalid",
    acl,
    mfaRequired: false,
    now: NOW,
  };
}

describe("M9 建用户: 授权先于副作用（第 169 条）", () => {
  it("test_more_privileged_acl_is_rejected_without_side_effects", async () => {
    const store = fakeConsoleUserStore();
    const status = await statusOf(async () => addConsoleUser(store, input(aclOf(adminPermission()))));

    expect(status.code).toBe(Code.InvalidArgument);
    expect(status.message).toBe("Cannot create users with more permissions than the current session.");
    expect(store.state.inserts).toBe(0);
    expect(store.state.audits).toBe(0);
  });

  it("test_empty_acl_is_rejected_without_side_effects", async () => {
    const store = fakeConsoleUserStore();
    const status = await statusOf(async () => addConsoleUser(store, input({})));

    expect(status.code).toBe(Code.InvalidArgument);
    expect(status.message).toBe("User must have at least some permissions.");
    expect(store.state.inserts).toBe(0);
    expect(store.state.audits).toBe(0);
  });
});

describe("M9 建用户: 校验顺序与文案", () => {
  it("test_rejects_changing_your_own_configuration_first", async () => {
    const store = fakeConsoleUserStore();
    const status = await statusOf(async () =>
      addConsoleUser(store, { ...input({ ACCOUNT: { write: true } }), username: CREATOR }),
    );
    expect(status.code).toBe(Code.FailedPrecondition);
    expect(status.message).toBe("Cannot change own configuration");
    expect(store.state.inserts).toBe(0);
  });

  it("test_username_rules_report_the_upstream_wording", async () => {
    const store = fakeConsoleUserStore();
    const empty = await statusOf(async () =>
      addConsoleUser(store, { ...input({ ACCOUNT: { write: true } }), username: "" }),
    );
    expect(empty.message).toBe("Username is required");

    const tooShort = await statusOf(async () =>
      addConsoleUser(store, { ...input({ ACCOUNT: { write: true } }), username: "ab" }),
    );
    expect(tooShort.message.startsWith("Username must be 3-20 long")).toBe(true);

    const reserved = await statusOf(async () =>
      addConsoleUser(store, { ...input({ ACCOUNT: { write: true } }), username: "Admin" }),
    );
    expect(reserved.message).toBe("Username cannot be the console configured username");
    expect(store.state.inserts).toBe(0);
  });

  it("test_email_rules_report_the_upstream_wording", async () => {
    const store = fakeConsoleUserStore();
    const missing = await statusOf(async () =>
      addConsoleUser(store, { ...input({ ACCOUNT: { write: true } }), email: "" }),
    );
    expect(missing.message).toBe("Email is required");

    const malformed = await statusOf(async () =>
      addConsoleUser(store, { ...input({ ACCOUNT: { write: true } }), email: "not-an-email" }),
    );
    expect(malformed.message).toBe("Not a valid email address");
    expect(store.state.inserts).toBe(0);
  });

  it("test_a_valid_grant_writes_the_user_and_one_audit_row", async () => {
    const store = fakeConsoleUserStore();
    const granted = aclOf(
      compose(newPermissionFromName("ACCOUNT", Read), newPermissionFromName("ACCOUNT", Write)),
    );
    const record = await addConsoleUser(store, {
      ...input(granted, fullAccount),
      username: "Operator",
    });

    expect(record.username).toBe("operator");
    expect(record.email).toBe("invaliduser@example.invalid");
    expect(store.state.inserts).toBe(1);
    expect(store.state.audits).toBe(1);
    expect(store.state.auditEntries[0]?.action).toBe("CREATE");
    // 落库的 ACL 是 `{"admin":false,"acl":{...}}`：ACCOUNT 读写为真、删除为假。
    const persisted = aclOf(permissionFromJson(record.aclJson));
    expect(persisted.ACCOUNT).toEqual({ read: true, write: true, delete: false });
    expect(persisted.ACCOUNT_WALLET).toEqual({ read: false, write: false, delete: false });
    expect(record.aclJson.startsWith('{"admin":false,"acl":{')).toBe(true);
  });
});
