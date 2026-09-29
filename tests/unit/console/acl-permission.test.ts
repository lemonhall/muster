import { describe, expect, it } from "vitest";

import {
  PermissionLevel,
  aclOf,
  adminPermission,
  compose,
  hasAccess,
  isAdmin,
  isNone,
  newPermission,
  newPermissionFromName,
  nonePermission,
  permissionFromAcl,
  permissionFromBytes,
  permissionFromJson,
  permissionFromString,
  permissionToJson,
  permissionToString,
} from "../../../src/domain/console/acl/permission";
import { ACL_RESOURCES } from "../../../src/domain/console/acl/resources";

/**
 * M9 单元测试：控制台 ACL 位图模型（覆盖矩阵第 168 条，
 * 搬运 `console/acl/acl_test.go::Test_Permission`）。
 *
 * 反作弊点：`hasAccess` 与 `ACL()` 展开**两件事都要逐格断言**——只断言"位图非空"
 * 会漏掉"位序写反了但自洽"这种最危险的实现。
 *
 * 溯源: console/acl/acl_test.go::Test_Permission
 *
 * 契约源（机器可读）：
 * 契约源: console/acl/acl.go::Permission.HasAccess
 * 契约源: console/acl/acl.go::Permission.ACL
 *
 * REQ-0001-021
 */

const { Read, Write, Delete } = PermissionLevel;

/** 上游测试里那份四段合成的权限：ACCOUNT 读写 + 钱包读 + 导出删。 */
function fixture(): ReturnType<typeof nonePermission> {
  return compose(
    compose(
      compose(newPermissionFromName("ACCOUNT", Read), newPermissionFromName("ACCOUNT", Write)),
      newPermissionFromName("ACCOUNT_WALLET", Read),
    ),
    newPermissionFromName("ACCOUNT_EXPORT", Delete),
  );
}

describe("M9 ACL: Test_Permission 的搬运（HasAccess）", () => {
  it("test_composed_permissions_answer_each_query_individually", () => {
    const permission = fixture();

    expect(hasAccess(permission, newPermissionFromName("ACCOUNT", Read))).toBe(true);
    expect(hasAccess(permission, newPermissionFromName("ACCOUNT", Write))).toBe(true);
    expect(hasAccess(permission, newPermissionFromName("ACCOUNT_EXPORT", Delete))).toBe(true);
    // 没授予的那一位必须是假，而不是"位图非空所以放行"。
    expect(hasAccess(permission, newPermissionFromName("ACCOUNT", Delete))).toBe(false);
    expect(hasAccess(permission, newPermissionFromName("ACCOUNT_WALLET", Write))).toBe(false);
    expect(hasAccess(permission, newPermissionFromName("ACCOUNT_EXPORT", Read))).toBe(false);
  });

  it("test_none_requirement_is_always_allowed_and_admin_allows_everything", () => {
    // 上游 `HasAccess` 的两个早退分支：required 为 None → 真。
    expect(hasAccess(fixture(), nonePermission())).toBe(true);
    expect(hasAccess(nonePermission(), nonePermission())).toBe(true);
    // owner 是管理员 → 真（哪怕 required 是全量）。
    expect(hasAccess(adminPermission(), permissionFromAcl({ ACCOUNT: { read: true } }))).toBe(true);
    expect(hasAccess(adminPermission(), adminPermission())).toBe(true);
  });
});

describe("M9 ACL: Test_Permission 的搬运（ACL 逐格展开）", () => {
  it("test_account_read_write_true_delete_false", () => {
    const account = aclOf(fixture()).ACCOUNT;
    expect(account).toEqual({ read: true, write: true, delete: false });
  });

  it("test_account_wallet_has_read_only", () => {
    const wallet = aclOf(fixture()).ACCOUNT_WALLET;
    expect(wallet).toEqual({ read: true, write: false, delete: false });
  });

  it("test_account_export_has_delete_only", () => {
    const exported = aclOf(fixture()).ACCOUNT_EXPORT;
    expect(exported).toEqual({ read: false, write: false, delete: true });
  });

  it("test_an_untouched_resource_is_all_false", () => {
    // 展开表里**每一个**资源都有键（30 项），没碰过的那些三项全假。
    const expanded = aclOf(fixture());
    expect(Object.keys(expanded)).toHaveLength(ACL_RESOURCES.length);
    expect(expanded.NOTIFICATION).toEqual({ read: false, write: false, delete: false });
  });

  it("test_admin_expands_to_every_resource_and_level", () => {
    const expanded = aclOf(adminPermission());
    for (const resource of ACL_RESOURCES) {
      expect(expanded[resource]).toEqual({ read: true, write: true, delete: true });
    }
  });

  it("test_none_expands_to_nothing", () => {
    const expanded = aclOf(nonePermission());
    for (const resource of ACL_RESOURCES) {
      expect(expanded[resource]).toEqual({ read: false, write: false, delete: false });
    }
  });
});

describe("M9 ACL: 位图形态与归一", () => {
  it("test_bitmap_is_twelve_bytes_with_the_bit_order_of_upstream", () => {
    const permission = newPermission(0, Read);
    expect(permission.bitmap).toHaveLength(12);
    // ACCOUNT=0、Read=0 → 目标位 0 → 最高位（大端）。
    expect(permission.bitmap[0]).toBe(0b1000_0000);
    // ACCOUNT_EXPORT=2、Delete=2 → 目标位 8 → 第二个字节的最高位。
    expect(newPermission(2, Delete).bitmap[1]).toBe(0b1000_0000);
  });

  it("test_ninety_set_bits_normalize_to_admin_in_both_encodings", () => {
    // 全部 30 个资源 × 3 个级别逐个显式置位，应当归一成 Admin()。
    let explicit = nonePermission();
    for (let resource = 0; resource < ACL_RESOURCES.length; resource += 1) {
      for (const level of [Read, Write, Delete]) {
        explicit = compose(explicit, newPermission(resource, level));
      }
    }
    expect(isAdmin(permissionFromAcl(aclOf(explicit)))).toBe(true);
    expect(permissionToString(explicit)).toBe(permissionToString(adminPermission()));
    expect(permissionToJson(explicit)).toBe('{"admin":true}');
  });

  it("test_string_encoding_round_trips_and_rejects_wrong_lengths", () => {
    const permission = fixture();
    expect(isNone(permissionFromString(permissionToString(permission)))).toBe(false);
    expect(permissionToString(permissionFromString(permissionToString(permission)))).toBe(
      permissionToString(permission),
    );
    expect(isNone(permissionFromBytes(new Uint8Array(3)))).toBe(true);
  });

  it("test_json_round_trips_and_defaults_missing_cells_to_false", () => {
    const permission = fixture();
    const restored = permissionFromJson(permissionToJson(permission));
    expect(permissionToString(restored)).toBe(permissionToString(permission));
    // `{"acl":{"ACCOUNT":{"read":true}}}` → ACCOUNT 只有读。
    const partial = permissionFromJson('{"acl":{"ACCOUNT":{"read":true}}}');
    expect(aclOf(partial).ACCOUNT).toEqual({ read: true, write: false, delete: false });
    expect(aclOf(partial).ACCOUNT_WALLET).toEqual({ read: false, write: false, delete: false });
    // `{"admin":true}` 直接就是全量。
    expect(isAdmin(permissionFromJson('{"admin":true}'))).toBe(true);
  });
});
