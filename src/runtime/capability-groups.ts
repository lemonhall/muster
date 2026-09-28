/**
 * `nk` 的群组面。
 *
 * 与数据面同一套纪律（租户来自闭包、落到既有领域服务），另有两条形状上的对齐：
 *
 * 1. **返回 camelCase**：上游 JS 运行时把 `api.Group` 折成 `{id, creatorId, name,
 *    avatarUrl, langTag, open, edgeCount, maxCount, createTime, updateTime}` 再交给模块，
 *    而不是直接给 protojson（protojson 是 REST 那一边的形状，蛇形命名）。
 * 2. **两个列表各有一个包装对象**：`groupUsersList` 回 `{groupUsers, cursor}`、
 *    `userGroupsList` 回 `{userGroups, cursor}`，成员项是 `{user, state}`、
 *    入群项是 `{group, state}`。上游测试读的正是这两层嵌套。
 *
 * 群成员的 `user` 里上游还带了 `online` / `edgeCount`（该用户全站的群数）与各社交
 * 平台 id：本项目的用户表没有这些字段，如实不填而不是编一个默认值。
 *
 * 契约源（机器可读）：
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.groupCreate
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.groupUpdate
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.groupDelete
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.groupUsersList
 * 契约源: server/runtime_javascript_nakama.go::RuntimeJavascriptNakamaModule.userGroupsList
 *
 * REQ-0001-020
 */

import type { DataContext } from "./capability-data";
import { createGroup, deleteGroupRows, updateGroup } from "../domain/groups/service";
import { listGroupUsers, listUserGroups } from "../domain/groups/listing";
import type { GroupFieldPatch } from "../domain/groups/group-writes";
import type { GroupRow, GroupUserRow, UserGroupRow } from "../domain/groups/types";
import { DEFAULT_GROUP_MAX_COUNT } from "../domain/groups/types";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 用户 id 的规范形态。
 *
 * 上游用 Postgres 的 `uuid` 类型比较，天生大小写不敏感；本项目把 id 存成文本，
 * 所以"规范化"必须在入口做一次（与 `http/routes/storage.ts::canonicalUserId` 同一条规则）。
 * 模块只要统一用会话里给的 `ctx.userId`，就不会踩到大小写这件事。
 */
function canonicalUserId(value: unknown): string {
  const raw = text(value);
  return raw === "" ? "" : raw.toUpperCase();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function metadataText(value: unknown): string {
  if (value === undefined || value === null) return "{}";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function groupBody(row: GroupRow): Record<string, unknown> {
  return {
    id: row.id,
    creatorId: row.creator_id,
    name: row.name,
    description: row.description,
    avatarUrl: row.avatar_url,
    langTag: row.lang_tag,
    metadata: row.metadata === "" ? {} : (JSON.parse(row.metadata) as unknown),
    // 上游这里是**布尔 `open`**（`api.Group.open` 的包装类型），不是 `state`。
    open: row.state === 0,
    edgeCount: row.edge_count,
    maxCount: row.max_count,
    createTime: row.create_time,
    updateTime: row.update_time,
  };
}

function memberBody(row: GroupUserRow): Record<string, unknown> {
  return {
    user: {
      userId: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      langTag: row.lang_tag,
      location: row.location,
      timezone: row.timezone,
      metadata: row.metadata === "" ? {} : (JSON.parse(row.metadata) as unknown),
      createTime: row.create_time,
      updateTime: row.update_time,
    },
    state: row.state,
  };
}

function inGroupBody(row: UserGroupRow): Record<string, unknown> {
  const group: GroupRow = {
    id: row.id,
    creator_id: row.creator_id,
    name: row.name,
    description: row.description,
    avatar_url: row.avatar_url,
    lang_tag: row.lang_tag,
    metadata: row.metadata,
    state: row.state,
    edge_count: row.edge_count,
    max_count: row.max_count,
    create_time: row.create_time,
    update_time: row.update_time,
  };
  return { group: groupBody(group), state: row.user_state };
}

/** 列表参数：上游缺省 `limit = 100`、`state` 不传表示不过滤（`-1` 同义）。 */
function listArgs(args: readonly unknown[]): {
  readonly limit: number | undefined;
  readonly state: number | undefined;
  readonly cursor: string;
} {
  const rawLimit = args[1];
  const limit = typeof rawLimit === "number" ? rawLimit : undefined;
  if (limit !== undefined && (limit < 1 || limit > 10000)) {
    throw new TypeError("expects limit to be 1-10000");
  }
  const rawState = args[2];
  let state: number | undefined;
  if (typeof rawState === "number" && rawState !== -1) {
    if (rawState < 0 || rawState > 4) throw new TypeError("expects state to be 0-4");
    state = rawState;
  }
  return { limit, state, cursor: text(args[3]) };
}

export function buildNkGroups(data: DataContext): Record<string, unknown> {
  const db = data.env.DB;
  const tenantId = data.tenantId;

  return {
    groupCreate: async (...args: unknown[]) => {
      const userId = canonicalUserId(args[0]);
      const name = text(args[1]);
      if (userId === "") throw new TypeError("expects a user ID string");
      if (name === "") throw new TypeError("expects group name to not be empty");
      const creatorId = canonicalUserId(args[2]) || userId;
      const row = await createGroup(
        data.env,
        tenantId,
        userId,
        {
          name,
          description: text(args[4]),
          langTag: text(args[3]),
          avatarUrl: text(args[5]),
          open: args[6] === true,
          maxCount: typeof args[8] === "number" ? args[8] : DEFAULT_GROUP_MAX_COUNT,
          creatorId,
          metadata: metadataText(args[7]),
        },
        nowSeconds(),
      );
      return groupBody(row);
    },

    groupUpdate: async (...args: unknown[]) => {
      const groupId = text(args[0]);
      const userId = canonicalUserId(args[1]);
      // `GroupFieldPatch` 的字段是只读的（REST 那一边逐条构造），这里要逐步填充，
      // 所以显式摊掉只读修饰符，而不是到处写类型断言。
      const patch: { -readonly [K in keyof GroupFieldPatch]: GroupFieldPatch[K] } = {};
      const name = optionalText(args[2]);
      const description = optionalText(args[3]);
      const avatarUrl = optionalText(args[4]);
      const langTag = optionalText(args[5]);
      if (name !== undefined) patch.name = name;
      if (description !== undefined) patch.description = description;
      if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl;
      if (langTag !== undefined) patch.langTag = langTag;
      if (args[6] !== undefined && args[6] !== null) {
        patch.metadata = metadataText(args[6]);
      }
      if (typeof args[7] === "boolean") patch.open = args[7];
      await updateGroup(data.env, tenantId, groupId, userId, patch, nowSeconds());
    },

    // 上游的 `groupDelete` 没有调用者参数：平台自己删，不走成员权限判定。
    groupDelete: async (groupId: unknown) => {
      await deleteGroupRows(data.env, tenantId, text(groupId));
    },

    groupUsersList: async (...args: unknown[]) => {
      const options = listArgs(args);
      const result = await listGroupUsers(db, tenantId, text(args[0]), {
        limit: options.limit,
        state: options.state,
        cursor: options.cursor,
      });
      return {
        groupUsers: result.groupUsers.map(memberBody),
        cursor: result.cursor === "" ? null : result.cursor,
      };
    },

    userGroupsList: async (...args: unknown[]) => {
      const options = listArgs(args);
      const result = await listUserGroups(db, tenantId, canonicalUserId(args[0]), {
        limit: options.limit,
        state: options.state,
        cursor: options.cursor,
      });
      return {
        userGroups: result.userGroups.map(inGroupBody),
        cursor: result.cursor === "" ? null : result.cursor,
      };
    },
  };
}
