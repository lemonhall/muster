import { describe, expect, it } from "vitest";

import { Code } from "../../../src/http/grpc";
import {
  PermissionLevel,
  adminPermission,
  compose,
  nonePermission,
  newPermissionFromName,
} from "../../../src/domain/console/acl/permission";
import {
  ACL_GRANT_EMPTY,
  ACL_GRANT_TOO_WIDE,
  ACL_TARGET_TOO_WIDE,
  validateConsoleUserACLGrant,
  validateConsoleUserTargetACL,
} from "../../../src/domain/console/users/policy";
import { statusOf } from "../../helpers/console-users";

/**
 * M9 单元测试：两条控制台授权规则（覆盖矩阵第 170 条与第 172 条）。
 *
 * 搬运自：
 *   - `server/console_user_add_acl_test.go::TestValidateConsoleUserACLGrant`
 *   - `server/console_user_reset_password_acl_test.go::TestValidateConsoleUserTargetACL`
 *
 * 两件事必须一起钉住：**状态码**（客户端按它分支）与**逐字文案**（客户端按它展示）。
 * 只断言码会在文案被改坏时静默通过。
 *
 * REQ-0001-021
 */

const { Read, Write } = PermissionLevel;

describe("M9 授权规则: validateConsoleUserACLGrant（第 170 条）", () => {
  const limited = compose(
    newPermissionFromName("ACCOUNT", Read),
    newPermissionFromName("ACCOUNT", Write),
  );

  const cases = [
    { name: "same permissions", requested: limited, code: Code.OK },
    { name: "fewer permissions", requested: newPermissionFromName("ACCOUNT", Read), code: Code.OK },
    { name: "no permissions", requested: nonePermission(), code: Code.InvalidArgument },
    { name: "admin permissions", requested: adminPermission(), code: Code.InvalidArgument },
  ] as const;

  for (const testCase of cases) {
    it(`test_${testCase.name.replaceAll(" ", "_")}`, async () => {
      const status = await statusOf(async () =>
        validateConsoleUserACLGrant(limited, testCase.requested),
      );
      expect(status.code).toBe(testCase.code);
    });
  }

  it("test_the_two_rejections_carry_distinct_upstream_messages", async () => {
    const empty = await statusOf(async () => validateConsoleUserACLGrant(limited, nonePermission()));
    expect(empty.message).toBe(ACL_GRANT_EMPTY);
    const tooWide = await statusOf(async () =>
      validateConsoleUserACLGrant(limited, adminPermission()),
    );
    expect(tooWide.message).toBe(ACL_GRANT_TOO_WIDE);
  });
});

describe("M9 授权规则: validateConsoleUserTargetACL（第 172 条）", () => {
  const limited = compose(
    newPermissionFromName("USER", Read),
    newPermissionFromName("USER", Write),
  );

  const cases = [
    { name: "equal permissions", target: limited, code: Code.OK },
    { name: "lower permissions", target: newPermissionFromName("USER", Read), code: Code.OK },
    { name: "admin permissions", target: adminPermission(), code: Code.PermissionDenied },
  ] as const;

  for (const testCase of cases) {
    it(`test_${testCase.name.replaceAll(" ", "_")}`, async () => {
      const status = await statusOf(async () =>
        validateConsoleUserTargetACL(limited, testCase.target),
      );
      expect(status.code).toBe(testCase.code);
    });
  }

  it("test_the_rejection_carries_the_upstream_message", async () => {
    const status = await statusOf(async () =>
      validateConsoleUserTargetACL(limited, adminPermission()),
    );
    expect(status.message).toBe(ACL_TARGET_TOO_WIDE);
  });
});
