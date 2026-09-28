/**
 * 群组生命周期里的五条操作：建、改、删、加入、离开。
 *
 * 每条都逐条对齐上游 `core_group.go` 的分支顺序，因为**顺序本身是契约**：客户端拿到
 * 哪一条错误、什么时候产生通知、什么时候往群频道写事件，都取决于它。
 *
 * 三处值得单独看一眼的地方：
 *
 * 1. **满员有两种判法**。加入前的 `edge_count >= max_count` 是"进分支前的粗判"，
 *    真正的判据是"加计数改到 0 行"（并发下的唯一可靠判据）。本项目把容量条件同时写进
 *    INSERT 与 UPDATE，于是"边写进去了但没计数"这种中间态不存在；写入 0 行时再查一次
 *    边是否存在，就能把"已经是成员"与"群满了"分开——上游靠主键唯一冲突与 0 行两次判断
 *    做同一件事。
 * 2. **加入私有群不是加入**：它写一条 `JOIN_REQUEST`(3) 边，然后给所有
 *    SUPERADMIN/ADMIN 发 `-5` 通知。所以"申请"这件事只存在于通知里，群成员列表默认
 *    （`state <= 3`）看得到申请人，`state=2` 过滤时才看不到。
 * 3. **最后一个 superadmin 退群会被拦**，但"最后一个成员"退群会**变成删群**
 *    （上游把这次操作转成 `DeleteGroup`）。两者差一个"还有没有别的成员"。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_group.go::CreateGroup
 * 契约源: server/core_group.go::UpdateGroup
 * 契约源: server/core_group.go::DeleteGroup
 * 契约源: server/core_group.go::JoinGroup
 * 契约源: server/core_group.go::LeaveGroup
 *
 * REQ-0001-012
 */

import { alreadyExists, invalidArgument, internal, notFound } from "../../http/errors";
import type { Bindings } from "../../env";
import { CHANNEL_MESSAGE_TYPE } from "../../realtime/channel";
import { sendNotifications, type SendNotificationInput } from "../notifications/service";
import { NOTIFICATION_CODE } from "../notifications/codes";
import {
  deleteMembership,
  insertJoinRequestPair,
  insertMemberPair,
} from "./edges";
import {
  bumpGroupEdgeCount,
  deleteGroupStatements,
  insertCreatorEdge,
  insertGroup,
  nextGroupPosition,
  updateGroupFields,
  type GroupFieldPatch,
} from "./group-writes";
import { evictGroupChannel, evictGroupPresence, postGroupEvent } from "./notify";
import {
  countOtherMembers,
  findEdgeState,
  findGroupById,
} from "./store";
import { GROUP_MANAGE_ROLE, GROUP_ROLE, GROUP_STATE, type GroupCaller, type GroupRow } from "./types";

export interface CreateGroupInput {
  readonly name: string;
  readonly description: string;
  readonly langTag: string;
  readonly avatarUrl: string;
  readonly open: boolean;
  readonly maxCount: number;
}

/**
 * 建群：群 + 创建者的 SUPERADMIN 边在**一个批次**里落地。
 *
 * 重名由 `insertGroup` 的 `WHERE NOT EXISTS` 判定（0 行 = 名字被占用），所以这里
 * 不依赖 D1 的约束错误文案——错误文案是运行时细节，不该变成业务分支的条件。
 * `metadata` 上游走控制台/运行时接口，REST 建群没有这个字段，如实写 `{}`。
 */
export async function createGroup(
  env: Bindings,
  tenantId: string,
  callerId: string,
  input: CreateGroupInput,
  now: number,
): Promise<GroupRow> {
  const groupId = crypto.randomUUID().toUpperCase();
  const position = await nextGroupPosition(env.DB, tenantId);
  const results = await env.DB.batch([
    insertGroup(env.DB, tenantId, {
      id: groupId,
      creatorId: callerId,
      name: input.name,
      description: input.description,
      avatarUrl: input.avatarUrl,
      langTag: input.langTag,
      metadata: "{}",
      open: input.open,
      maxCount: input.maxCount,
      now,
    }),
    ...insertCreatorEdge(env.DB, tenantId, groupId, callerId, position, now),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) throw alreadyExists("Group name is in use.");

  const group = await findGroupById(env.DB, tenantId, groupId);
  if (group === null) throw internal("Error while trying to create group.");
  return group;
}

/**
 * 改群：调用者必须是 SUPERADMIN 或 ADMIN（`state <= 1`）。
 *
 * 无权限与"群不存在"回**同一句** `Group not found or you're not allowed to update.`
 * ——上游刻意不区分（不告诉调用者"这个群存在但你没资格"）。"一个字段都没传"是 400，
 * "传了但都是旧值"也是 400 但文案不同，两者都由这里判掉。
 */
export async function updateGroup(
  env: Bindings,
  tenantId: string,
  groupId: string,
  callerId: string,
  patch: GroupFieldPatch,
  now: number,
): Promise<void> {
  const state = await findEdgeState(env.DB, tenantId, groupId, callerId);
  if (state === null || state > GROUP_MANAGE_ROLE) {
    throw notFound("Group not found or you're not allowed to update.");
  }
  if (Object.keys(patch).length === 0) {
    throw invalidArgument("Specify at least one field to update.");
  }
  if (patch.name !== undefined) {
    const taken = await env.DB.prepare(
      "SELECT 1 AS present FROM groups WHERE tenant_id = ?1 AND name = ?2 AND id <> ?3",
    )
      .bind(tenantId, patch.name, groupId)
      .first<{ present: number }>();
    if (taken !== null) throw invalidArgument("Group name is in use.");
  }

  const result = await updateGroupFields(env.DB, tenantId, groupId, patch, now).run();
  if ((result.meta.changes ?? 0) === 0) throw invalidArgument("No new fields in group update.");
}

/**
 * 删群：只有 SUPERADMIN（`state <= 0`）能删。
 *
 * 权限不足与群不存在合成同一句，但状态码是 **400**（`codes.InvalidArgument`）——
 * 这是上游唯一一条"权限拒绝用 InvalidArgument"的端点（改群是 404），照抄。
 */
export async function deleteGroup(
  env: Bindings,
  tenantId: string,
  groupId: string,
  callerId: string,
): Promise<void> {
  const state = await findEdgeState(env.DB, tenantId, groupId, callerId);
  if (state === null || state > GROUP_ROLE.superadmin) {
    throw invalidArgument("Group not found or you're not allowed to delete.");
  }
  await deleteGroupRows(env, tenantId, groupId);
}

/**
 * 删群的**无权限版**：只删行，不判权限。
 *
 * 两个调用点：REST 的删群（权限已在上面判过）与"最后一个成员退群"（上游把那次操作
 * 转成 `DeleteGroup`，权限判断在转换前已经做过——能退群就说明他至少是成员）。
 */
export async function deleteGroupRows(
  env: Bindings,
  tenantId: string,
  groupId: string,
): Promise<void> {
  await env.DB.batch(deleteGroupStatements(env.DB, tenantId, groupId));
  await evictGroupChannel(env, tenantId, groupId);
}

/**
 * 加入群组。开放群直接成为 MEMBER，私有群留下一条申请并通知管理员。
 *
 * 重复加入（以及被封禁的人再来）都是**成功的空操作**：上游把它当"关系已存在"，
 * 既不报错也不重复发通知。
 */
export async function joinGroup(
  env: Bindings,
  tenantId: string,
  groupId: string,
  caller: GroupCaller,
  now: number,
): Promise<void> {
  const group = await findGroupById(env.DB, tenantId, groupId);
  if (group === null) throw notFound("Group not found.");
  if (group.edge_count >= group.max_count) throw invalidArgument("Group is full.");

  const position = await nextGroupPosition(env.DB, tenantId);
  if (group.state === GROUP_STATE.open) {
    const results = await env.DB.batch(
      insertMemberPair(env.DB, tenantId, groupId, caller.id, GROUP_ROLE.member, position, now),
    );
    if ((results[0]?.meta.changes ?? 0) === 0) {
      // 0 行只有两种可能：边已经存在（含"被封禁"），或者群在这一瞬间满了。
      if ((await findEdgeState(env.DB, tenantId, groupId, caller.id)) === null) {
        throw invalidArgument("Group is full.");
      }
      return;
    }
    await postGroupEvent(env, tenantId, groupId, {
      code: CHANNEL_MESSAGE_TYPE.groupJoin,
      userId: caller.id,
      username: caller.username,
    });
    return;
  }

  const results = await env.DB.batch(
    insertJoinRequestPair(env.DB, tenantId, groupId, caller.id, GROUP_ROLE.joinRequest, position, now),
  );
  if ((results[0]?.meta.changes ?? 0) === 0) return;
  await notifyGroupAdmins(env, tenantId, groupId, caller, now);
}

/** 私有群的加入申请：`-5` 通知发给群里所有 SUPERADMIN 与 ADMIN。 */
async function notifyGroupAdmins(
  env: Bindings,
  tenantId: string,
  groupId: string,
  caller: GroupCaller,
  now: number,
): Promise<void> {
  const admins = await env.DB.prepare(
    "SELECT destination_id FROM group_edge WHERE tenant_id = ?1 AND source_id = ?2 AND (state = 0 OR state = 1)",
  )
    .bind(tenantId, groupId)
    .all<{ destination_id: string }>();
  const notifications: SendNotificationInput[] = admins.results.map((row) => ({
    userId: row.destination_id,
    subject: `User ${caller.username} wants to join your group`,
    content: JSON.stringify({ group_id: groupId, username: caller.username }),
    code: NOTIFICATION_CODE.groupJoinRequest,
    senderId: caller.id,
  }));
  await sendNotifications(env, tenantId, now, notifications);
}

/**
 * 离开群组。
 *
 * 三种"其实什么也不用做"的情况：没有关系（没加过）、被封禁、以及——
 * 最后一个 superadmin 但群里还有别人（这时**报错**，不是空操作）。
 * 反过来，"最后一个成员"退群会被转成删群。
 */
export async function leaveGroup(
  env: Bindings,
  tenantId: string,
  groupId: string,
  caller: GroupCaller,
  now: number,
): Promise<void> {
  const state = await findEdgeState(env.DB, tenantId, groupId, caller.id);
  if (state === null) return;
  if (state === GROUP_ROLE.banned) return;

  if (state === GROUP_ROLE.superadmin) {
    const counts = await countOtherMembers(env.DB, tenantId, groupId, caller.id);
    if (counts.otherSuperadmins === 0) {
      if (counts.otherMembers === 0) {
        await deleteGroupRows(env, tenantId, groupId);
        return;
      }
      throw invalidArgument("Cannot leave group when you are the last superadmin.");
    }
  }

  const deletedState = await deleteMembership(env.DB, tenantId, groupId, caller.id);
  if (deletedState !== null && deletedState < GROUP_ROLE.joinRequest) {
    await bumpGroupEdgeCount(env.DB, tenantId, groupId, -1, now);
  }
  await postGroupEvent(env, tenantId, groupId, {
    code: CHANNEL_MESSAGE_TYPE.groupLeave,
    userId: caller.id,
    username: caller.username,
  });
  await evictGroupPresence(env, tenantId, groupId, caller.id);
}
