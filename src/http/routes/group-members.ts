/**
 * 群成员管理的五条写端点 + 一条群成员列表。
 *
 * 五条写的共同形状（顺序即契约）：
 *   1. `groupId` 空 → `Group ID must be set.`；非法 → `Group ID must be a valid ID.`
 *      ——这一步**在**"userIds 为空就直接成功"**之前**；
 *   2. `userIds` 依次校验，任一条非法（含全零 UUID）→ `User ID must be a valid ID.`
 *      ——也是整体先校验完再动手（上游在事务里，一个不合法就整体回滚）；
 *   3. 进领域层，错误文案由各操作自己那句英文决定。
 *
 * `demote` 是唯一一个"空 `userIds` 报错"的（`User IDs must be set.`），
 * 其余四条空集直接 200 `{}`。这是上游的不一致，照抄。
 *
 * `userIds` 在 **query**（`collectionFormat: multi`），不是 JSON body。
 *
 * 契约源（机器可读）：
 * 契约源: server/api_group.go::AddGroupUsers
 * 契约源: server/api_group.go::BanGroupUsers
 * 契约源: server/api_group.go::KickGroupUsers
 * 契约源: server/api_group.go::PromoteGroupUsers
 * 契约源: server/api_group.go::DemoteGroupUsers
 * 契约源: server/api_group.go::ListGroupUsers
 *
 * REQ-0001-012
 */

import { json, queryList, queryOptionalInt, queryValue } from "../body";
import { invalidArgument } from "../errors";
import type { Router } from "../router";
import { requireGroupId, requireUserId } from "../../domain/groups/ids";
import { listGroupUsers } from "../../domain/groups/listing";
import {
  addGroupUsers,
  banGroupUsers,
  demoteGroupUsers,
  kickGroupUsers,
  promoteGroupUsers,
} from "../../domain/groups/membership";
import { registryOnline } from "../../durable/registry-call";
import { groupUserListBody } from "../../wire/group";
const LIMIT_ERROR = "Invalid limit - limit must be between 1 and 100.";
const STATE_ERROR = "Invalid state - state must be between 0 and 4.";

/** query 里的 `userIds`：`classic` 与 `snake` 两种写法都收，与本项目其它端点一致。 */
function readUserIds(url: URL): string[] {
  return queryList(url, "userIds", "user_ids").map((raw) => requireUserId(raw));
}

type MemberOperation = (
  env: Parameters<typeof promoteGroupUsers>[0],
  tenantId: string,
  groupId: string,
  caller: Parameters<typeof promoteGroupUsers>[3],
  userIds: readonly string[],
  now: number,
) => Promise<void>;

/**
 * 五条写端点的共同外壳：解析 → 校验 → 调用。
 *
 * `allowEmpty` 就是上面那条不一致：只有 `demote` 传 false。
 */
function memberOperation(
  operation: MemberOperation,
  emptyMessage: string | null,
): Parameters<Router["handleUser"]>[2] {
  return async (context) => {
    const groupId = requireGroupId(context.params["groupId"] ?? "");
    const raw = queryList(context.url, "userIds", "user_ids");
    if (raw.length === 0) {
      if (emptyMessage === null) return json({});
      throw invalidArgument(emptyMessage);
    }
    const userIds = raw.map((entry) => requireUserId(entry));
    await operation(
      context.env,
      context.tenantEnv.tenantId,
      groupId,
      context.session.user,
      userIds,
      context.tenantEnv.nowSec,
    );
    return json({});
  };
}

export function registerGroupMemberRoutes(router: Router): void {
  router.handleUser("POST", "/v2/group/{groupId}/add", memberOperation(addGroupUsers, null));
  router.handleUser("POST", "/v2/group/{groupId}/ban", memberOperation(banGroupUsers, null));
  router.handleUser("POST", "/v2/group/{groupId}/kick", memberOperation(kickGroupUsers, null));
  router.handleUser(
    "POST",
    "/v2/group/{groupId}/promote",
    memberOperation(promoteGroupUsers, null),
  );
  router.handleUser(
    "POST",
    "/v2/group/{groupId}/demote",
    memberOperation(demoteGroupUsers, "User IDs must be set."),
  );

  router.handleUser("GET", "/v2/group/{groupId}/user", async (context) => {
    const groupId = requireGroupId(context.params["groupId"] ?? "");
    const limit = queryOptionalInt(context.url, "limit", LIMIT_ERROR);
    const state = queryOptionalInt(context.url, "state", STATE_ERROR);
    const result = await listGroupUsers(context.env.DB, context.tenantEnv.tenantId, groupId, {
      ...(limit === undefined ? {} : { limit }),
      ...(state === undefined ? {} : { state }),
      cursor: queryValue(context.url, "cursor"),
    });
    const online = await registryOnline(
      context.env,
      context.tenantEnv.tenantId,
      result.groupUsers.map((row) => row.id),
    );
    return json(groupUserListBody(result, online));
  });
}
