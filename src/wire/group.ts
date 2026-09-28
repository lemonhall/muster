/**
 * 群组端点的线格式（protojson + `UseProtoNames`，与好友/身份同一套规则）。
 *
 * 四条容易写错、都从上游 `api.pb.go` 的定义推出来的地方：
 *   1. `api.Group.open` 是 `google.protobuf.BoolValue`（**包装类型**），所以它永远是
 *      一个裸布尔而不是 `{"value":false}`，而且**即使 false 也出现**——上游
 *      `sqlMapper` 总是给它一个非 nil 的包装对象。这与"普通 bool 的 false 被省略"不同；
 *   2. `edge_count` / `max_count` 是普通 int32：为 0 时整条省略（建群时两者都 ≥1，
 *      所以实践中总在）；
 *   3. `metadata` 是**普通 string**（不是 Struct/StringValue），空串省略；
 *   4. `GroupUserList.GroupUser.state` 与 `UserGroupList.UserGroup.state` 是
 *      `Int32Value` 包装类型：裸数字、且 `0`（SUPERADMIN）照样出现。
 *
 * 契约源（机器可读）：
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/group
 * 契约源: vendor/github.com/heroiclabs/nakama-common/api/api.pb.go::Group
 *
 * REQ-0001-012
 */

import type { GroupListResult, GroupUserListResult, UserGroupListResult } from "../domain/groups/listing";
import { GROUP_STATE, type GroupRow } from "../domain/groups/types";
import { formatTimestamp, userBody } from "./identity";

/** 空串省略（proto3 的零值），非空才出现。 */
function text(key: string, value: string): Record<string, unknown> {
  return value === "" ? {} : { [key]: value };
}

function count(key: string, value: number): Record<string, unknown> {
  return value === 0 ? {} : { [key]: value };
}

export function groupBody(row: GroupRow): Record<string, unknown> {
  return {
    id: row.id,
    creator_id: row.creator_id,
    name: row.name,
    ...text("description", row.description),
    ...text("lang_tag", row.lang_tag),
    ...text("metadata", row.metadata),
    ...text("avatar_url", row.avatar_url),
    // BoolValue 永远在（哪怕 false）。
    open: row.state === GROUP_STATE.open,
    ...count("edge_count", row.edge_count),
    ...count("max_count", row.max_count),
    create_time: formatTimestamp(row.create_time),
    update_time: formatTimestamp(row.update_time),
  };
}

export function groupListBody(result: GroupListResult): Record<string, unknown> {
  return {
    ...(result.groups.length === 0 ? {} : { groups: result.groups.map((row) => groupBody(row)) }),
    ...text("cursor", result.cursor),
  };
}

export function groupUserListBody(
  result: GroupUserListResult,
  onlineIds: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  return {
    ...(result.groupUsers.length === 0
      ? {}
      : {
          group_users: result.groupUsers.map((row) => ({
            user: userBody(row, onlineIds.has(row.id)),
            state: row.state,
          })),
        }),
    ...text("cursor", result.cursor),
  };
}

/**
 * 用户群组列表**不填** online：上游 `ApiServer.ListUserGroups` 根本没有把
 * `statusRegistry` 传下去（只有 `ListGroupUsers` 传了）。这里如实不填，
 * 而不是"顺手也给个默认值"。
 */
export function userGroupListBody(result: UserGroupListResult): Record<string, unknown> {
  return {
    ...(result.userGroups.length === 0
      ? {}
      : {
          user_groups: result.userGroups.map((row) => ({
            group: groupBody(row),
            state: row.user_state,
          })),
        }),
    ...text("cursor", result.cursor),
  };
}
