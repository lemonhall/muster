import { describe, expect, it } from "vitest";

import { Code } from "../../../src/http/grpc";
import {
  PermissionLevel,
  compose,
  adminPermission,
  newPermissionFromName,
  permissionToJson,
  type Permission,
} from "../../../src/domain/console/acl/permission";
import { resetConsoleUserPassword } from "../../../src/domain/console/users/service";
import { fakeConsoleUserStore, statusOf } from "../../helpers/console-users";

/**
 * M9 单元测试：重置密码前必须先读目标的 ACL 并授权
 * （覆盖矩阵第 171 条，搬运
 * `server/console_user_reset_password_acl_test.go::TestResetUserPasswordAuthorizesTargetACLBeforeUpdate`）。
 *
 * 六格覆盖的是六条不同的失败路径，其中三格的**更新次数必须是 0**——这是本条 DoD 的
 * 反作弊点：只看状态码的话，"先写后验"的实现也能凑出 403，但计数骗不过去。
 * 另外两格钉住"读失败重试一次"与"畸形 ACL 失败关闭"。
 *
 * 溯源: server/console_user_reset_password_acl_test.go::TestResetUserPasswordAuthorizesTargetACLBeforeUpdate
 *
 * REQ-0001-021
 */

const { Read, Write } = PermissionLevel;

const callerRole: Permission = compose(
  newPermissionFromName("USER", Read),
  newPermissionFromName("USER", Write),
);
const NOW = 1_800_000_000;

const cells = [
  { name: "equal permissions issue reset code", role: callerRole, updates: 1, code: Code.OK },
  {
    name: "lower permissions issue reset code",
    role: newPermissionFromName("USER", Read),
    updates: 1,
    code: Code.OK,
  },
  {
    name: "serialization failure is retried",
    role: callerRole,
    readFailures: 1,
    updates: 1,
    selectCount: 2,
    code: Code.OK,
  },
  { name: "admin permissions are rejected", role: adminPermission(), updates: 0, code: Code.PermissionDenied },
  { name: "malformed target ACL fails closed", aclText: "{", updates: 0, code: Code.Internal },
  { name: "missing target preserves not found", aclText: "missing", updates: 0, code: Code.NotFound },
] as const;

function targetAclFor(cell: (typeof cells)[number]): string | null {
  if ("aclText" in cell && cell.aclText === "missing") return null;
  if ("aclText" in cell) return cell.aclText;
  return permissionToJson(cell.role as Permission);
}

describe("M9 重置密码: 目标 ACL 授权（第 171 条）", () => {
  for (const cell of cells) {
    it(`test_${cell.name.replaceAll(" ", "_")}`, async () => {
      const store = fakeConsoleUserStore({
        targetAcl: targetAclFor(cell),
        readFailures: "readFailures" in cell ? cell.readFailures : 0,
      });

      const result = await statusOf(async () => {
        const response = await resetConsoleUserPassword(store, {
          callerPermission: callerRole,
          targetUsername: "target",
          now: NOW,
          passwordHashIterations: 1_000,
        });
        expect(response.code).not.toBe("");
        return response;
      });

      expect(result.code).toBe(cell.code);
      expect(store.state.writes).toBe(cell.updates);
      expect(store.state.reads).toBe("selectCount" in cell ? cell.selectCount : 1);
    });
  }

  it("test_the_denied_cell_carries_the_upstream_message", async () => {
    const store = fakeConsoleUserStore({ targetAcl: permissionToJson(adminPermission()) });
    const status = await statusOf(async () =>
      resetConsoleUserPassword(store, {
        callerPermission: callerRole,
        targetUsername: "target",
        now: NOW,
      }),
    );
    expect(status.message).toBe(
      "Cannot reset the password of a user with permissions outside the current session.",
    );
    expect(store.state.writes).toBe(0);
    expect(store.state.audits).toBe(0);
  });

  it("test_a_successful_reset_writes_a_hashed_password_and_one_audit_row", async () => {
    const store = fakeConsoleUserStore({ targetAcl: permissionToJson(callerRole) });
    await resetConsoleUserPassword(store, {
      callerPermission: callerRole,
      targetUsername: "target",
      now: NOW,
      passwordHashIterations: 1_000,
    });

    const patch = store.state.patches[0];
    expect(patch?.passwordHash.startsWith("pbkdf2-sha256$1000$")).toBe(true);
    // 一次性 code 存的是哈希，不是明文。
    expect(patch?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(patch?.codeExpiry).toBe(NOW + 3600);
    expect(store.state.audits).toBe(1);
    expect(store.state.auditEntries[0]?.action).toBe("UPDATE");
  });
});
