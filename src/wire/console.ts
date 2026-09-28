/**
 * 控制台端点的线格式。
 *
 * 这里是本项目**唯一**一处与客户端 API 的 protojson 规则**相反**的地方，所以单独成文件：
 * 控制台的 gateway 用的是
 * `UseProtoNames: true, UseEnumNumbers: true, EmitUnpopulated: true`
 * （`server/console.go`），而客户端 API 是 protojson 默认（省略零值）。差别具体是：
 *
 *   - `EmitUnpopulated: true` → **零值也要出现**：`mfa_required: false`、
 *     `next_cursor: ""`、空列表 `items: []`、以及 `acl` 里每一项
 *     `{"read":false,"write":false,"delete":false}` 都必须写出来；
 *   - `UseProtoNames: true` → 字段名是 snake_case（与客户端 API 相同）；
 *   - `UseEnumNumbers: true` → 枚举发数字；本文件的三个响应里没有枚举字段，
 *     所以这条暂时只影响将来新增的字段。
 *
 * 如果照客户端 API 的规则"省略零值"，前端的 `Permissions` 表格会整列消失，
 * 而它是要逐格显示的。
 *
 * 契约源（机器可读）：
 * 契约源: server/console.go::StartConsoleServer
 * 契约源: console/console.proto::User
 * 契约源: console/console.proto::WalletLedgerList
 *
 * REQ-0001-021
 */

import { aclOf, permissionFromJson } from "../domain/console/acl/permission";
import type { ConsoleUserRecord } from "../domain/console/users/service";
import type { WalletLedgerListRow } from "../domain/competitive/wallet/store";
import { formatTimestamp } from "./identity";

/**
 * 把落库的 ACL JSON 展开成 `map<string, Permissions>`。
 *
 * 30 个资源的键**一个不少**：`EmitUnpopulated` 下 map 的条目是"键存在就发"，
 * 而"这个资源没有权限"与"响应里没有这个资源"在控制台表格里是两件事。
 */
export function consoleAclBody(aclJson: string): Record<string, Record<string, boolean>> {
  const expanded = aclOf(permissionFromJson(aclJson));
  const out: Record<string, Record<string, boolean>> = {};
  for (const [resource, flags] of Object.entries(expanded)) {
    out[resource] = { read: flags.read, write: flags.write, delete: flags.delete };
  }
  return out;
}

export function consoleUserBody(record: ConsoleUserRecord): Record<string, unknown> {
  return {
    id: record.id,
    username: record.username,
    email: record.email,
    acl: consoleAclBody(record.aclJson),
    mfa_required: record.mfaRequired,
    mfa_enabled: record.mfaEnabled,
    create_time: formatTimestamp(record.createTime),
    update_time: formatTimestamp(record.updateTime),
  };
}

export function consoleUserListBody(records: readonly ConsoleUserRecord[]): Record<string, unknown> {
  return { users: records.map(consoleUserBody) };
}

function walletLedgerItem(row: WalletLedgerListRow, userId: string): Record<string, unknown> {
  return {
    id: row.id,
    user_id: userId,
    // `changeset` / `metadata` 在 proto 里是 string（内含 JSON），原样透传。
    changeset: row.changeset,
    metadata: row.metadata,
    create_time: formatTimestamp(row.create_time),
    update_time: formatTimestamp(row.update_time),
  };
}

export function walletLedgerListBody(
  rows: readonly WalletLedgerListRow[],
  userId: string,
  nextCursor: string,
  prevCursor: string,
): Record<string, unknown> {
  return {
    items: rows.map((row) => walletLedgerItem(row, userId)),
    next_cursor: nextCursor,
    prev_cursor: prevCursor,
  };
}
