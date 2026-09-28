/**
 * 控制台 ACL 的**位图权限模型**，逐位对齐上游 `console/acl/acl.go`。
 *
 * 形状是"每个资源 3 个位（read / write / delete），资源按下标顺序排进一个字节数组"，
 * 一共 `ceil(30*3/8) = 12` 字节。判权限的三条语义必须原样保留，因为它们决定了
 * "谁能改谁"：
 *   1. `hasAccess(owner, required)`：`required` 为空 → 真；`owner` 是管理员 → 真；
 *      否则 `required` 的每一位都必须在 `owner` 里置位。
 *   2. `compose` 是**按位或**，所以"给自己发权限"就是把对方的位合进来。
 *   3. 只要 90 个位全置齐，就等价于管理员——`permissionToString` 与 `permissionToJson`
 *      都会把它**归一成管理员形态**（前者把补位也填 1，后者只写 `{"admin":true}`）。
 *
 * 契约源（机器可读）：
 * 契约源: console/acl/acl.go::Permission.Compose
 * 契约源: console/acl/acl.go::Permission.HasAccess
 * 契约源: console/acl/acl.go::Permission.ACL
 * 契约源: console/acl/acl.go::New
 * 契约源: console/acl/acl.go::NewFromJson
 * 契约源: console/acl/acl.go::ToJson
 *
 * REQ-0001-021
 */

import { fromBase64UrlBytes, toBase64UrlBytes } from "../../base64url";
import {
  ACL_RESOURCES,
  ACL_RESOURCE_BIT_COUNT,
  ACL_RESOURCE_COUNT,
  ACL_RESOURCE_INDEX,
  type AclResource,
} from "./resources";

/** 上游 `PermissionRead` / `PermissionWrite` / `PermissionDelete` 的数值。 */
export const PermissionLevel = { Read: 0, Write: 1, Delete: 2 } as const;
export type PermissionLevel = (typeof PermissionLevel)[keyof typeof PermissionLevel];

/** 上游 `byteCount = ceil(len(AclResources)*3/8)` = 12。 */
export const ACL_BYTE_COUNT = Math.ceil(ACL_RESOURCE_BIT_COUNT / 8);

export interface Permission {
  readonly bitmap: Uint8Array;
}

/** 每个资源展开出来的三个开关，对应上游 `console.Permissions`。 */
export interface PermissionFlags {
  readonly read: boolean;
  readonly write: boolean;
  readonly delete: boolean;
}

export type AclMap = Readonly<Partial<Record<string, Partial<PermissionFlags> | null>>>;

/** 上游 `None()`：12 个零字节。 */
export function nonePermission(): Permission {
  return { bitmap: new Uint8Array(ACL_BYTE_COUNT) };
}

/** 上游 `Admin()`：12 个 0xFF。 */
export function adminPermission(): Permission {
  return { bitmap: new Uint8Array(ACL_BYTE_COUNT).fill(0xff) };
}

export function isNone(permission: Permission): boolean {
  return permission.bitmap.every((byte) => byte === 0);
}

export function isAdmin(permission: Permission): boolean {
  return permission.bitmap.every((byte) => byte === 0xff);
}

/**
 * 上游 `NewPermission(resource, level)`：把 `resource*3 + level` 这一个位置 1。
 *
 * 位序是**大端**的（`1 << (7 - j)`）——写成小端会得到一份自洽但和上游不兼容的
 * 位图，而"兼容"正是这个文件的全部意义。
 */
export function newPermission(resource: number, level: number): Permission {
  const bytes = new Uint8Array(ACL_BYTE_COUNT);
  const targetBit = resource * 3 + level;
  const byteIndex = Math.floor(targetBit / 8);
  const bitInByte = targetBit % 8;
  bytes[byteIndex] = (bytes[byteIndex] ?? 0) | (1 << (7 - bitInByte));
  return { bitmap: bytes };
}

/** 上游 `NewPermissionFromString`：未知资源名静默退化成 `None()`。 */
export function newPermissionFromName(resource: string, level: number): Permission {
  const index = ACL_RESOURCE_INDEX[resource];
  return index === undefined ? nonePermission() : newPermission(index, level);
}

/** 上游 `Compose`：按位或。 */
export function compose(left: Permission, right: Permission): Permission {
  const bytes = new Uint8Array(ACL_BYTE_COUNT);
  for (let index = 0; index < ACL_BYTE_COUNT; index += 1) {
    bytes[index] = (left.bitmap[index] ?? 0) | (right.bitmap[index] ?? 0);
  }
  return { bitmap: bytes };
}

/**
 * 上游 `HasAccess`：`required` 是 `None` 或 `owner` 是管理员时一律放行；
 * 否则要求 `required` 的每一位都在 `owner` 里置位。
 */
export function hasAccess(owner: Permission, required: Permission): boolean {
  if (isNone(required) || isAdmin(owner)) return true;
  for (let index = 0; index < ACL_BYTE_COUNT; index += 1) {
    const mask = required.bitmap[index] ?? 0;
    if (((owner.bitmap[index] ?? 0) & mask) !== mask) return false;
  }
  return true;
}

/**
 * 上游 `ACL()`：把位图逐格展开成 `{资源: {read, write, delete}}`。
 *
 * 展开用的是 `HasAccess` 而不是"读某一位"，因为两者在**管理员**身上不同：
 * 管理员只置了 12 个字节的每一位（含 6 个补位），逐格展开才会得到
 * "30 个资源 × 3 个级别全为真"。这一点是第 1 条 DoD 的反作弊点。
 */
export function aclOf(permission: Permission): Record<AclResource, PermissionFlags> {
  const expanded = {} as Record<AclResource, PermissionFlags>;
  ACL_RESOURCES.forEach((resource, index) => {
    expanded[resource] = {
      read: hasAccess(permission, newPermission(index, PermissionLevel.Read)),
      write: hasAccess(permission, newPermission(index, PermissionLevel.Write)),
      delete: hasAccess(permission, newPermission(index, PermissionLevel.Delete)),
    };
  });
  return expanded;
}

/** 上游 `New(acl)`：把一张 `{资源: {read, write, delete}}` 表折成位图。 */
export function permissionFromAcl(acl: AclMap): Permission {
  let accumulated = nonePermission();
  let setBits = 0;
  for (const [resource, flags] of Object.entries(acl)) {
    if (flags === null || flags === undefined) continue;
    if (!(resource in ACL_RESOURCE_INDEX)) continue;
    for (const [level, enabled] of [
      [PermissionLevel.Read, flags.read],
      [PermissionLevel.Write, flags.write],
      [PermissionLevel.Delete, flags.delete],
    ] as const) {
      if (enabled !== true) continue;
      accumulated = compose(accumulated, newPermissionFromName(resource, level));
      setBits += 1;
    }
  }
  // 90 个位全被显式置齐 → 上游直接给 Admin()（连 6 个补位也填 1）。
  return setBits === ACL_RESOURCE_BIT_COUNT ? adminPermission() : accumulated;
}

/** 上游 `NewFromBytes`：长度不对就是 `None()`（而不是抛异常）。 */
export function permissionFromBytes(bytes: Uint8Array): Permission {
  if (bytes.length !== ACL_BYTE_COUNT) return nonePermission();
  return { bitmap: Uint8Array.from(bytes) };
}

export interface StoredPermission {
  readonly admin?: boolean;
  readonly acl?: Record<string, Partial<PermissionFlags>>;
}

/**
 * 上游 `NewFromJson`：库里存的是 `{"admin":bool,"acl":{...}}`。
 *
 * `acl` 表缺某个资源等价于"这个资源三个位都是假"；`admin` 为真则整张表被忽略。
 */
export function permissionFromJson(text: string): Permission {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("console ACL JSON must be an object");
  }
  const stored = parsed as StoredPermission;
  if (stored.admin === true) return adminPermission();
  const table = stored.acl ?? {};
  const normalized: Record<string, PermissionFlags> = {};
  for (const resource of ACL_RESOURCES) {
    const flags = table[resource];
    normalized[resource] = {
      read: flags?.read === true,
      write: flags?.write === true,
      delete: flags?.delete === true,
    };
  }
  return permissionFromAcl(normalized);
}

/**
 * 上游 `ToJson`：`{"admin":true}` 或 `{"admin":false,"acl":{30 项}}`。
 *
 * 键的顺序固定成资源表顺序，`acl` 表**永远包含全部 30 个资源**——上游那个
 * `dbAclEntry` 结构体的存在就是为了"缺格写成 false 而不是省略键"。
 */
export function permissionToJson(permission: Permission): string {
  const expanded = aclOf(permission);
  const allFlagsSet = ACL_RESOURCES.every((resource) => {
    const flags = expanded[resource];
    return flags.read && flags.write && flags.delete;
  });
  if (allFlagsSet) return JSON.stringify({ admin: true });
  const acl: Record<string, PermissionFlags> = {};
  for (const resource of ACL_RESOURCES) acl[resource] = expanded[resource];
  return JSON.stringify({ admin: false, acl });
}

/**
 * 上游 `Permission.String()`：base64url（无填充）的位图。
 *
 * 位图"逻辑上"只有 90 位，剩下 6 位是补位；当 90 位全置齐时上游把补位也刷成 1
 * 再编码，于是"等价管理员"在这里只有一个字节串，不会出现两种形态。
 */
export function permissionToString(permission: Permission): string {
  let setBits = 0;
  for (const byte of permission.bitmap) {
    for (let bit = 0; bit < 8; bit += 1) {
      if ((byte & (1 << (7 - bit))) !== 0) setBits += 1;
    }
  }
  const encoded = setBits === ACL_RESOURCE_BIT_COUNT ? adminPermission() : permission;
  return toBase64UrlBytes(encoded.bitmap);
}

/** `permissionToString` 的逆：长度不对就是 `None()`（与上游 `NewFromBytes` 同）。 */
export function permissionFromString(encoded: string): Permission {
  return permissionFromBytes(fromBase64UrlBytes(encoded));
}

/** 资源名列表（只读），给"逐格断言"这类测试用。 */
export const ALL_ACL_RESOURCES: readonly AclResource[] = ACL_RESOURCES;

export { ACL_RESOURCE_COUNT };
