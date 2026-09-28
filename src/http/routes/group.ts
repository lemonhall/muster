/**
 * 群组的生命周期端点（建、改、删、加入、离开）+ 群目录 + 某人的群列表。
 *
 * 成员管理那五条（add/ban/kick/promote/demote）与群成员列表在 `group-members.ts`，
 * 拆开的理由只有一个：合起来会超出一个文件该有的体量（≤300 行），而它们的校验
 * 前半段是同一个形状（group id → userIds），放一起反而更好读。
 *
 * 三个容易看漏的输入位置（照 swagger，不是猜测）：
 *   - `POST /v2/group` 与 `PUT /v2/group/{groupId}` 收 **JSON body**（`in: body`）；
 *   - `POST /v2/group/{groupId}/{add,ban,kick,promote,demote}` 的 `userIds` 在 **query**
 *     里（`collectionFormat: multi`），这些端点的 body 是空的；
 *   - `GET /v2/group` 的过滤条件全在 query：`name` / `langTag` / `members` / `open`。
 *
 * 校验顺序照抄上游 `ApiServer.*`：先 id、再字段、最后才进领域层——因为"哪一条错先
 * 报出来"是客户端能观察到的行为。
 *
 * 契约源（机器可读）：
 * 契约源: apigrpc/apigrpc.swagger.json::/v2/group
 * 契约源: server/api_group.go::CreateGroup
 * 契约源: server/api_group.go::UpdateGroup
 * 契约源: server/api_group.go::DeleteGroup
 * 契约源: server/api_group.go::JoinGroup
 * 契约源: server/api_group.go::LeaveGroup
 * 契约源: server/api_group.go::ListGroups
 * 契约源: server/api_group.go::ListUserGroups
 *
 * REQ-0001-012
 */

import { asObject, json, optionalBool, optionalInt, optionalString, parseBody, queryOptionalBool, queryOptionalInt, queryValue } from "../body";
import { invalidArgument } from "../errors";
import type { Router } from "../router";
import { requireGroupId, requireUserGroupOwnerId } from "../../domain/groups/ids";
import { listGroups, listUserGroups } from "../../domain/groups/listing";
import { createGroup, deleteGroup, joinGroup, leaveGroup, updateGroup } from "../../domain/groups/service";
import { DEFAULT_GROUP_MAX_COUNT } from "../../domain/groups/types";
import { groupBody, groupListBody, userGroupListBody } from "../../wire/group";
import { registerGroupMemberRoutes } from "./group-members";

const LIMIT_ERROR = "Invalid limit - limit must be between 1 and 100.";
const STATE_ERROR = "Invalid state - state must be between 0 and 4.";

/**
 * 建群：名字必填，`max_count` 只在"给了且不合法"时才报错（`0` 与缺省都表示用默认值）。
 *
 * 注意 `open` 在 `CreateGroupRequest` 里是**普通 bool**（不是 BoolValue），
 * 所以缺省就是 false——即"不传 open 建出来的是私有群"。这与 `ListGroups` 的
 * `open`（BoolValue，"没给"和"false"是两件事）不是同一种语义。
 */
function readCreateInput(body: Record<string, unknown>): Parameters<typeof createGroup>[3] {
  const name = optionalString(body, "name") ?? "";
  if (name === "") throw invalidArgument("Group name must be set.");

  const maxCount = optionalInt(body, "max_count");
  let resolvedMaxCount = DEFAULT_GROUP_MAX_COUNT;
  if (maxCount !== undefined && maxCount !== 0) {
    if (maxCount < 1) throw invalidArgument("Group max count must be >= 1 when set.");
    resolvedMaxCount = maxCount;
  }

  return {
    name,
    description: optionalString(body, "description") ?? "",
    langTag: optionalString(body, "lang_tag") ?? "",
    avatarUrl: optionalString(body, "avatar_url") ?? "",
    open: optionalBool(body, "open") ?? false,
    maxCount: resolvedMaxCount,
  };
}

/**
 * 改群：字段是 StringValue/BoolValue，"给了空串"与"没给"是两件事。
 *
 * 空串的 name / langTag 在 api 层就被拦下（"Group name cannot be empty." /
 * "Group language cannot be empty."）；空串的 description / avatar 则是合法输入
 * （上游把它们写成 NULL，本项目写空串）。`open` 给了就写，`false` 是"改成私有群"。
 */
function readUpdatePatch(body: Record<string, unknown>): Parameters<typeof updateGroup>[4] {
  const name = optionalString(body, "name");
  if (name !== undefined && name.length < 1) throw invalidArgument("Group name cannot be empty.");
  const langTag = optionalString(body, "lang_tag");
  if (langTag !== undefined && langTag.length < 1) {
    throw invalidArgument("Group language cannot be empty.");
  }
  const description = optionalString(body, "description");
  const avatarUrl = optionalString(body, "avatar_url");
  const open = optionalBool(body, "open");
  return {
    ...(name === undefined ? {} : { name }),
    ...(langTag === undefined ? {} : { langTag }),
    ...(description === undefined ? {} : { description }),
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
    ...(open === undefined ? {} : { open }),
  };
}

export function registerGroupRoutes(router: Router): void {
  router.handleUser("GET", "/v2/group", async (context) => {
    const limit = queryOptionalInt(context.url, "limit", LIMIT_ERROR);
    const members = queryOptionalInt(context.url, "members", LIMIT_ERROR);
    const open = queryOptionalBool(context.url, "open");
    const result = await listGroups(context.env.DB, context.tenantEnv.tenantId, {
      name: queryValue(context.url, "name"),
      langTag: queryValue(context.url, "langTag", "lang_tag"),
      ...(open === undefined ? {} : { open }),
      ...(members === undefined ? {} : { members }),
      ...(limit === undefined ? {} : { limit }),
      cursor: queryValue(context.url, "cursor"),
    });
    return json(groupListBody(result));
  });

  router.handleUser("POST", "/v2/group", async (context) => {
    const body = asObject(await parseBody(context.request), "body");
    const row = await createGroup(
      context.env,
      context.tenantEnv.tenantId,
      context.session.user.id,
      readCreateInput(body),
      context.tenantEnv.nowSec,
    );
    return json(groupBody(row));
  });

  router.handleUser("PUT", "/v2/group/{groupId}", async (context) => {
    const groupId = requireGroupId(context.params["groupId"] ?? "");
    const body = asObject(await parseBody(context.request), "body");
    await updateGroup(
      context.env,
      context.tenantEnv.tenantId,
      groupId,
      context.session.user.id,
      readUpdatePatch(body),
      context.tenantEnv.nowSec,
    );
    return json({});
  });

  router.handleUser("DELETE", "/v2/group/{groupId}", async (context) => {
    const groupId = requireGroupId(context.params["groupId"] ?? "");
    await deleteGroup(context.env, context.tenantEnv.tenantId, groupId, context.session.user.id);
    return json({});
  });

  router.handleUser("POST", "/v2/group/{groupId}/join", async (context) => {
    const groupId = requireGroupId(context.params["groupId"] ?? "");
    await joinGroup(
      context.env,
      context.tenantEnv.tenantId,
      groupId,
      context.session.user,
      context.tenantEnv.nowSec,
    );
    return json({});
  });

  router.handleUser("POST", "/v2/group/{groupId}/leave", async (context) => {
    const groupId = requireGroupId(context.params["groupId"] ?? "");
    await leaveGroup(
      context.env,
      context.tenantEnv.tenantId,
      groupId,
      context.session.user,
      context.tenantEnv.nowSec,
    );
    return json({});
  });

  router.handleUser("GET", "/v2/user/{userId}/group", async (context) => {
    const userId = requireUserGroupOwnerId(context.params["userId"] ?? "");
    const limit = queryOptionalInt(context.url, "limit", LIMIT_ERROR);
    const state = queryOptionalInt(context.url, "state", STATE_ERROR);
    const result = await listUserGroups(context.env.DB, context.tenantEnv.tenantId, userId, {
      ...(limit === undefined ? {} : { limit }),
      ...(state === undefined ? {} : { state }),
      cursor: queryValue(context.url, "cursor"),
    });
    return json(userGroupListBody(result));
  });

  registerGroupMemberRoutes(router);
}
