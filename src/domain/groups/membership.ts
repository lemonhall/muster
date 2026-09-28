/**
 * 群成员管理的五条操作：加人、踢人、封禁、升职、降职。
 *
 * 五个端点共用同一个前置（`state <= 1`，也就是 SUPERADMIN 或 ADMIN），细节见
 * `membership-guards.ts`——那里解释了"群不存在与没权限为什么回同一句话"、
 * "为什么先整体校验账号存在"、"为什么调用者自己被排除在外"。
 *
 * 每一条对目标用户的处理都遵循同一个三段式，顺序不能换：
 *   1. 改库（加边 / 删边 / 改角色），**改到 0 行就跳过这个人**（上游的"关系已存在、
 *      不存在、或会动到最后一个 superadmin"三种情形之一）；
 *   2. 只有真的改动了才维护群计数（`edge_count` 数的是**成员**，不含申请与封禁）；
 *   3. 只有真的改动了才写群频道事件与通知。
 *
 * 一处与上游形状不同的地方：上游多次用"事务回滚"表达"一个用户失败就整体失败"。
 * 本项目受 D1 限制（一个 `batch` 是一次事务）把目标用户**先整体校验一遍**
 * （`One or more users not found.` 那一条），再把每个人各写一个原子批次；
 * 剩下的差别只在"第 N 个人遇到满员"时前面的写入已经生效，登记在 ECN-0008。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_group.go::AddGroupUsers
 * 契约源: server/core_group.go::BanGroupUsers
 * 契约源: server/core_group.go::KickGroupUsers
 * 契约源: server/core_group.go::PromoteGroupUsers
 * 契约源: server/core_group.go::DemoteGroupUsers
 *
 * REQ-0001-012
 */

import { invalidArgument, internal, notFound } from "../../http/errors";
import type { Bindings } from "../../env";
import { CHANNEL_MESSAGE_TYPE } from "../../realtime/channel";
import { sendNotifications, type SendNotificationInput } from "../notifications/service";
import { NOTIFICATION_CODE } from "../notifications/codes";
import { DENIED, requireExistingUsers, requireManager, uniqueTargets } from "./membership-guards";
import {
  deleteManagedMembership,
  insertBanned,
  insertMemberPair,
  shiftMembershipState,
  updateMembershipState,
} from "./edges";
import { bumpGroupEdgeCount, nextGroupPosition } from "./group-writes";
import { evictGroupPresence, postGroupEvent } from "./notify";
import { findEdgeState, findGroupName, findUsernames } from "./store";
import { GROUP_ROLE, type GroupCaller } from "./types";

/**
 * 加人：把若干用户直接加进群（`MEMBER`），并给每个人发 `-4` 通知。
 *
 * 已经存在的边分两种：`JOIN_REQUEST(3)` 会被**接受**（变成 MEMBER，并且计入成员数），
 * 其余状态（成员、被封禁）一律静默跳过——上游靠"改到 2 行才算数"区分它们。
 */
export async function addGroupUsers(
  env: Bindings,
  tenantId: string,
  groupId: string,
  caller: GroupCaller,
  userIds: readonly string[],
  now: number,
): Promise<void> {
  await requireManager(env, tenantId, groupId, caller.id);
  const targets = uniqueTargets(userIds, caller.id);
  if (targets.length === 0) return;
  const members = await requireExistingUsers(env, tenantId, targets);

  const name = await findGroupName(env.DB, tenantId, groupId);
  if (name === null) throw notFound(DENIED);
  const notifications: SendNotificationInput[] = [];

  for (const userId of targets) {
    const existing = await findEdgeState(env.DB, tenantId, groupId, userId);
    if (existing === null) {
      const position = await nextGroupPosition(env.DB, tenantId);
      const results = await env.DB.batch(
        insertMemberPair(env.DB, tenantId, groupId, userId, GROUP_ROLE.member, position, now),
      );
      if ((results[0]?.meta.changes ?? 0) === 0) throw invalidArgument("Group is full.");
    } else {
      const updated = await updateMembershipState(
        env.DB,
        tenantId,
        groupId,
        userId,
        GROUP_ROLE.joinRequest,
        GROUP_ROLE.member,
        now,
      );
      if ((updated.meta.changes ?? 0) !== 2) continue;
      await bumpGroupEdgeCount(env.DB, tenantId, groupId, 1, now);
    }

    await postGroupEvent(env, tenantId, groupId, {
      code: CHANNEL_MESSAGE_TYPE.groupAdd,
      userId,
      username: members.get(userId) ?? caller.username,
    });
    notifications.push({
      userId,
      subject: `You've been added to group ${name}`,
      content: JSON.stringify({ group_id: groupId, name }),
      code: NOTIFICATION_CODE.groupAdd,
      senderId: caller.id,
    });
  }

  await sendNotifications(env, tenantId, now, notifications);
}

/**
 * 踢人：把成员移出群（不发封禁边，所以对方还能再申请/加入）。
 *
 * superadmin 与 admin 的差别只在"能删哪些边"：admin 只能删 `state > 1` 的边，
 * 这条权限边界写在 DELETE 的 WHERE 里（`deleteManagedMembership`），所以 admin 踢
 * 另一个 admin 会安静地无事发生。
 */
export async function kickGroupUsers(
  env: Bindings,
  tenantId: string,
  groupId: string,
  caller: GroupCaller,
  userIds: readonly string[],
  now: number,
): Promise<void> {
  const callerState = await requireManager(env, tenantId, groupId, caller.id);
  const targets = uniqueTargets(userIds, caller.id);
  if (targets.length === 0) return;
  await requireExistingUsers(env, tenantId, targets);

  for (const userId of targets) {
    const deleted = await deleteManagedMembership(
      env.DB,
      tenantId,
      groupId,
      userId,
      callerState === GROUP_ROLE.superadmin,
    );
    const deletedState = deleted.results[0]?.state;
    if (deletedState === undefined) continue;
    if (deletedState >= GROUP_ROLE.joinRequest) continue;
    await bumpGroupEdgeCount(env.DB, tenantId, groupId, -1, now);
    const username = (await findUsernames(env.DB, tenantId, [userId])).get(userId);
    if (username === undefined) throw internal("Error while trying to kick users from a group.");
    await postGroupEvent(env, tenantId, groupId, {
      code: CHANNEL_MESSAGE_TYPE.groupKick,
      userId,
      username,
    });
    await evictGroupPresence(env, tenantId, groupId, userId);
  }
}

/**
 * 封禁：先删边、再补一条 `BANNED(4)` 的**单行**边。
 *
 * 那条单行边是"封禁"与"踢出"的全部差别：被封禁的人不会在自己的群列表里看到这个群
 * （列表读的是用户那一侧的边），但群成员列表按 `state=4` 过滤时能看到他，
 * 而且他再加入是静默失败（边已存在）。
 */
export async function banGroupUsers(
  env: Bindings,
  tenantId: string,
  groupId: string,
  caller: GroupCaller,
  userIds: readonly string[],
  now: number,
): Promise<void> {
  const callerState = await requireManager(env, tenantId, groupId, caller.id);
  const targets = uniqueTargets(userIds, caller.id);
  if (targets.length === 0) return;
  await requireExistingUsers(env, tenantId, targets);

  for (const userId of targets) {
    const deleted = await deleteManagedMembership(
      env.DB,
      tenantId,
      groupId,
      userId,
      callerState === GROUP_ROLE.superadmin,
    );
    const deletedState = deleted.results[0]?.state;
    if (deletedState === undefined) continue;
    const position = await nextGroupPosition(env.DB, tenantId);
    await insertBanned(env.DB, tenantId, groupId, userId, GROUP_ROLE.banned, position, now);
    if (deletedState >= GROUP_ROLE.joinRequest) continue;
    await bumpGroupEdgeCount(env.DB, tenantId, groupId, -1, now);
    const username = (await findUsernames(env.DB, tenantId, [userId])).get(userId);
    if (username === undefined) throw internal("Error while trying to ban users from a group.");
    await postGroupEvent(env, tenantId, groupId, {
      code: CHANNEL_MESSAGE_TYPE.groupBan,
      userId,
      username,
    });
    await evictGroupPresence(env, tenantId, groupId, userId);
  }
}

/**
 * 升职：`state - 1`（MEMBER → ADMIN → SUPERADMIN）。
 *
 * 区间是"不低于调用者的角色、且低于 MEMBER"，所以 superadmin 能把 admin 提成
 * superadmin、把 member 提成 admin；admin 只能把 member 提成 admin。
 */
export async function promoteGroupUsers(
  env: Bindings,
  tenantId: string,
  groupId: string,
  caller: GroupCaller,
  userIds: readonly string[],
  now: number,
): Promise<void> {
  const callerState = await requireManager(env, tenantId, groupId, caller.id);
  const targets = uniqueTargets(userIds, caller.id);
  if (targets.length === 0) return;

  for (const userId of targets) {
    const shifted = await shiftMembershipState(env.DB, tenantId, groupId, userId, now, {
      delta: -1,
      kind: "promote",
      callerState,
      requireOtherSuperadmin: false,
    });
    if (shifted.results.length === 0) continue;
    const username = (await findUsernames(env.DB, tenantId, [userId])).get(userId);
    if (username === undefined) throw internal("Error while trying to promote users in a group.");
    await postGroupEvent(env, tenantId, groupId, {
      code: CHANNEL_MESSAGE_TYPE.groupPromote,
      userId,
      username,
    });
  }
}

/**
 * 降职：`state + 1`（SUPERADMIN → ADMIN → MEMBER）。
 *
 * 两处保护：不能动比自己权限高的人；调用者是 superadmin 时，"降掉最后一个 superadmin"
 * 会被守卫拦住（改到 0 行 = 这个操作无效）。降职**不写通知**（上游只有频道事件）。
 */
export async function demoteGroupUsers(
  env: Bindings,
  tenantId: string,
  groupId: string,
  caller: GroupCaller,
  userIds: readonly string[],
  now: number,
): Promise<void> {
  const callerState = await requireManager(env, tenantId, groupId, caller.id);
  const targets = uniqueTargets(userIds, caller.id);
  if (targets.length === 0) return;

  for (const userId of targets) {
    const shifted = await shiftMembershipState(env.DB, tenantId, groupId, userId, now, {
      delta: 1,
      kind: "demote",
      callerState,
      requireOtherSuperadmin: callerState === GROUP_ROLE.superadmin,
    });
    if (shifted.results.length === 0) continue;
    const username = (await findUsernames(env.DB, tenantId, [userId])).get(userId);
    if (username === undefined) throw internal("Error while trying to demote users in a group.");
    await postGroupEvent(env, tenantId, groupId, {
      code: CHANNEL_MESSAGE_TYPE.groupDemote,
      userId,
      username,
    });
  }
}
