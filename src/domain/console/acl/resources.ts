/**
 * 控制台 ACL 的**资源表**。
 *
 * 顺序就是契约：每个资源的**下标**决定了它在位图里占用的 3 个位
 * （`下标*3 + 级别`），而上游的注释写得很直白——
 * `ATTENTION: These values cannot be changed as they represent the bit
 * positions in the ACL bitmap.` 所以这张表只能追加、不能重排、不能删。
 *
 * 上游的 30 项全部保留（含 Hiro 那一组）：只搬运"本项目会用到的子集"会改变
 * 所有资源的位偏移，那等于换了一套权限模型——对外表现就是"同一个 ACL JSON
 * 在两个实现里读出来的权限不一样"。
 *
 * 契约源（机器可读）：
 * 契约源: console/console.proto::AclResources
 * 契约源: console/acl/acl.go::byteCount
 *
 * REQ-0001-021
 */

export const ACL_RESOURCES = [
  "ACCOUNT",
  "ACCOUNT_WALLET",
  "ACCOUNT_EXPORT",
  "ACCOUNT_FRIENDS",
  "ACCOUNT_GROUPS",
  "ACCOUNT_NOTES",
  "ACL_TEMPLATE",
  "ALL_ACCOUNTS",
  "ALL_DATA",
  "ALL_STORAGE",
  "API_EXPLORER",
  "AUDIT_LOG",
  "CONFIGURATION",
  "CHANNEL_MESSAGE",
  "USER",
  "GROUP",
  "IN_APP_PURCHASE",
  "LEADERBOARD",
  "LEADERBOARD_RECORD",
  "MATCH",
  "NOTIFICATION",
  "SATORI_MESSAGE",
  "SETTINGS",
  "STORAGE_DATA",
  "STORAGE_DATA_IMPORT",
  "HIRO_INVENTORY",
  "HIRO_PROGRESSION",
  "HIRO_ECONOMY",
  "HIRO_STATS",
  "HIRO_ENERGY",
] as const;

export type AclResource = (typeof ACL_RESOURCES)[number];

export const ACL_RESOURCE_COUNT = ACL_RESOURCES.length;

/** 资源名 → 下标。未知资源名一律当作"没有这个资源"（上游 `New` 就是这么跳过它的）。 */
export const ACL_RESOURCE_INDEX: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(ACL_RESOURCES.map((resource, index) => [resource, index])),
);

/** 位图里实际写下的位数（30 × 3 = 90），用来判断"是不是等价于管理员"。 */
export const ACL_RESOURCE_BIT_COUNT = ACL_RESOURCE_COUNT * 3;
