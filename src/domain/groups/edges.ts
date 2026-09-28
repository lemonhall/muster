/**
 * 群组成员边的**写**语句（读全在 `store.ts`，群那一行的写全在 `group-writes.ts`）。
 *
 * 三条从上游逐字搬来的形状，写错任何一条都会让"库里的行"和上游不一样：
 *
 * 1. **成员边是两行、而且必须是同一条语句**：`groupAddUser` 一次插
 *    `(source=群, destination=用户)` 与 `(source=用户, destination=群)`，同 position、
 *    同 state（见 `migrations/0003_social.sql`）。两行分两条语句写会掉进两个坑：
 *    第二条会被"这一对边已经存在"的守卫挡住（因为它看得见第一条），而少了那一半的行
 *    会让"我的群列表"（用户 → 群）查不到这个群。所以这里用
 *    `INSERT ... SELECT ... UNION ALL SELECT ... WHERE NOT EXISTS(两向之一)`，
 *    一行都不写或两行一起写——与上游"整条 INSERT 撞唯一约束"的原子性一致。
 * 2. **"这次是不是新成员"由 position 认领**：上游靠唯一冲突把整个事务打回去，
 *    本项目用同一条语句里的 `NOT EXISTS` 判定 + 后一句"存在 position = 本次的边才加计数"，
 *    于是重复操作既不加计数也不报错（`meta.changes` 是唯一判据，不去猜）。
 * 3. **满员是"加计数改到 0 行"**：容量条件 `edge_count + 1 <= max_count` 写在
 *    INSERT 与 UPDATE 两处，所以"要不要写入"和"能不能计数"是同一个判断，不会出现
 *    "边写进去了但计数没加"的中间态。写入返回 0 行时，调用方再查一次边是否存在，
 *    就能把"已经是成员"与"群满了"分开——这正是上游靠唯一冲突 vs. 0 行两次判断做的事。
 *
 * 封禁与踢人用的是上游那两条**带"最后一个 superadmin"守卫的 DELETE**，逐字对应：
 * 守卫写在 DELETE 里（而不是先查后删），所以"删到 0 行"就是"操作无效"，
 * 不需要额外的一致性检查。`RETURNING state` 让调用方拿到被删掉的角色。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_group.go::groupAddUser
 * 契约源: server/core_group.go::groupUpdateUserState
 * 契约源: server/core_group.go::BanGroupUsers
 * 契约源: server/core_group.go::KickGroupUsers
 * 契约源: server/core_group.go::LeaveGroup
 * 契约源: server/core_group.go::PromoteGroupUsers
 * 契约源: server/core_group.go::DemoteGroupUsers
 *
 * REQ-0001-012
 */

import { GROUP_ROLE } from "./types";

/**
 * 一条边上"这两行之一"的写入。
 *
 * `guard` 有三档，对应上游三种不同的前置：
 *   - `capacity`：加成员（开放群加入、管理员加人）——群还没满才写；
 *   - `exists`：建群时写创建者那条边——群存在才写（`edge_count` 已经由建群那句设成 1，
 *     所以不能再用容量判断：`max_count = 1` 的群会让创建者自己写不进去）；
 *   - `none`：私有群的加入申请——上限已经由进分支前的那次读判过。
 */
export function pairInsert(
  db: D1Database,
  tenantId: string,
  groupId: string,
  sourceId: string,
  destinationId: string,
  state: number,
  position: number,
  now: number,
  guard: "capacity" | "exists" | "none",
): D1PreparedStatement {
  // ?1 租户 / ?2 群 / ?3 source / ?4 destination / ?5 state / ?6 position / ?7 now。
  //
   // **群 id 必须单独传**：这条语句要为两个方向各写一行（群→用户、用户→群），而守卫
   // 里的"这个群还在不在、还装得下吗"问的永远是**群**——用 `?3`（source）去当群 id，
   // 在反向那一行上问的就变成了"这个**用户**是不是一个群"，守卫永远为假（那一行写不进去）。
   // 两种守卫都要求群存在（子查询为空 → 不写入），容量那档再多一个 `edge_count + 1 <= max_count`。
   //
   // `NOT EXISTS` 查的是**两个方向**：上游把两行放在同一条 INSERT 里，只要这一对
   // `(source_id, destination_id)` 里任何一行已经存在，整条语句就撞上唯一约束而**一行都不写**
   // （`JoinGroup` 正是靠这个把"已经是成员 / 已被封禁"变成静默成功）。若这里只查一个方向，
   // "被封禁的人再来加入"就会把少了的那一半补进去，人就算重新进群了。
  const groupGuard =
    guard === "capacity"
      ? `AND EXISTS (SELECT 1 FROM groups
                     WHERE tenant_id = ?1 AND id = ?2 AND edge_count + 1 <= max_count)`
      : guard === "exists"
        ? `AND EXISTS (SELECT 1 FROM groups WHERE tenant_id = ?1 AND id = ?2)`
        : "";
  return db
    .prepare(
      `INSERT INTO group_edge (tenant_id, source_id, destination_id, state, position, update_time)
       SELECT * FROM (
         SELECT ?1, ?3, ?4, ?5, ?6, ?7
         UNION ALL
         SELECT ?1, ?4, ?3, ?5, ?6, ?7
       )
       WHERE NOT EXISTS (SELECT 1 FROM group_edge
                         WHERE tenant_id = ?1
                           AND ((source_id = ?3 AND destination_id = ?4)
                             OR (source_id = ?4 AND destination_id = ?3)))
       ${groupGuard}
       ON CONFLICT (tenant_id, source_id, destination_id) DO NOTHING`,
    )
    .bind(tenantId, groupId, sourceId, destinationId, state, position, now);
}

/**
 * 加入（或加人）时的一次原子批次：一对边 + 一句群计数。
 *
 * 第二条的 `EXISTS (... position = ?5)` 是"这次真的写了边"的判据：position 是本次
 * 操作现取的，所以只有本次那对边才对得上——重复加入时第一条 0 行，这一条也就改不到行。
 */
export function insertMemberPair(
  db: D1Database,
  tenantId: string,
  groupId: string,
  userId: string,
  state: number,
  position: number,
  now: number,
): D1PreparedStatement[] {
  return [
    pairInsert(db, tenantId, groupId, groupId, userId, state, position, now, "capacity"),
    db
      .prepare(
        `UPDATE groups SET edge_count = edge_count + 1, update_time = ?6
         WHERE tenant_id = ?1 AND id = ?2 AND edge_count + 1 <= max_count
           AND EXISTS (SELECT 1 FROM group_edge
                       WHERE tenant_id = ?1 AND source_id = ?2 AND destination_id = ?3
                         AND position = ?5)`,
      )
      .bind(tenantId, groupId, userId, state, position, now),
  ];
}

/**
 * 私有群的"加入申请"：两行边（state = 3），**不加计数**。
 *
 * 上限在上游是进这个分支之前用一次读判断的（`edge_count >= max_count` → 群满），
 * 所以这里也不带容量守卫——两处都查会让"刚被人占满"变成一句不同的错误。
 */
export function insertJoinRequestPair(
  db: D1Database,
  tenantId: string,
  groupId: string,
  userId: string,
  state: number,
  position: number,
  now: number,
): D1PreparedStatement[] {
  return [pairInsert(db, tenantId, groupId, groupId, userId, state, position, now, "none")];
}

/** 接受加入申请：`state 3 → 2`，**两行一起改**（上游 `groupUpdateUserState`）。 */
export function updateMembershipState(
  db: D1Database,
  tenantId: string,
  groupId: string,
  userId: string,
  fromState: number,
  toState: number,
  now: number,
): Promise<D1Result> {
  return db
    .prepare(
      `UPDATE group_edge SET state = ?4, update_time = ?5
       WHERE tenant_id = ?6
         AND ((source_id = ?1 AND destination_id = ?2 AND state = ?3)
           OR (source_id = ?2 AND destination_id = ?1 AND state = ?3))`,
    )
    .bind(groupId, userId, fromState, toState, now, tenantId)
    .run();
}

/**
 * 删掉双向边并**回带被删掉的角色**（离开群组、踢人/封禁前的取数都用它）。
 *
 * 上游用 `RETURNING state`；两行边的 state 恒相同（同一个 position 一起写的），
 * 所以取哪一行都是同一个值，这不构成"随机行为"。
 */
export async function deleteMembership(
  db: D1Database,
  tenantId: string,
  groupId: string,
  userId: string,
): Promise<number | null> {
  const result = await db
    .prepare(
      `DELETE FROM group_edge
       WHERE tenant_id = ?3
         AND ((source_id = ?1 AND destination_id = ?2) OR (source_id = ?2 AND destination_id = ?1))
       RETURNING state`,
    )
    .bind(groupId, userId, tenantId)
    .all<{ state: number }>();
  return result.results[0]?.state ?? null;
}

/**
 * 封禁/踢人用的删除：superadmin 版**不能删掉最后一个 superadmin**。
 *
 * 上游把这条守卫写进 DELETE（而不是先查后删），所以"0 行 = 这个操作无权限或无效"。
 * 逐字对应 `core_group.go` 里那两个分支：`myState == 0` 与 `myState != 0`。
 */
export function deleteManagedMembership(
  db: D1Database,
  tenantId: string,
  groupId: string,
  userId: string,
  authoritative: boolean,
): Promise<D1Result<{ state: number }>> {
  const target = authoritative
    ? "(source_id = ?2 AND destination_id = ?3) OR (source_id = ?3 AND destination_id = ?2)"
    : "(source_id = ?2 AND destination_id = ?3 AND state > 1) OR (source_id = ?3 AND destination_id = ?2 AND state > 1)";
  const guard = authoritative
    ? `AND NOT (
         EXISTS (SELECT 1 FROM group_edge WHERE tenant_id = ?1 AND source_id = ?2 AND destination_id = ?3 AND state = 0)
         AND (SELECT COUNT(destination_id) FROM group_edge
              WHERE tenant_id = ?1 AND source_id = ?2 AND destination_id <> ?3 AND state = 0) = 0
       )`
    : "";
  return db
    .prepare(
      `DELETE FROM group_edge
       WHERE tenant_id = ?1
         AND (${target})
         AND EXISTS (SELECT 1 FROM groups WHERE tenant_id = ?1 AND id = ?2)
         ${guard}
       RETURNING state`,
    )
    .bind(tenantId, groupId, userId)
    .all<{ state: number }>();
}

/**
 * 封禁后补的那**一行**边（`source = 群`、`state = 4`）。
 *
 * 上游是 `INSERT ... ON CONFLICT (source_id, state, position) DO UPDATE SET state = $2`，
 * 本项目的主键是 `(租户, source, destination)`，所以冲突目标换成它——效果相同：
 * 同一个用户在同一个群里只会留下一行"被封禁"的边。
 */
export function insertBanned(
  db: D1Database,
  tenantId: string,
  groupId: string,
  userId: string,
  state: number,
  position: number,
  now: number,
): Promise<D1Result> {
  return db
    .prepare(
      `INSERT INTO group_edge (tenant_id, source_id, destination_id, state, position, update_time)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (tenant_id, source_id, destination_id)
       DO UPDATE SET state = ?4, update_time = ?6`,
    )
    .bind(tenantId, groupId, userId, state, position, now)
    .run();
}

/**
 * 升降职：把两行边的 `state` 整体减一（升职）或加一（降职），并**回带新角色**。
 *
 * 上游那两句 UPDATE 的形状是"角色区间 + 方向"，区间**两处不一样**，照抄：
 *   - 升职：`state > 0 AND state > 调用者的角色 AND state <= MEMBER(2)`
 *     —— 能把 MEMBER 提成 ADMIN、把 ADMIN 提成 SUPERADMIN；superadmin 自己不在区间里
 *     （已经到头了），而且 admin 提不动另一个 admin；
 *   - 降职：`state >= 调用者的角色 AND state < MEMBER(2)`
 *     —— 只能降 SUPERADMIN 与 ADMIN，且不能动比自己权限高的人；
 *   - 两条都是**两行一起改**（改到 2 行才算成功），改到 0 行就是"这件事不该发生"
 *     （没这条边、角色不在区间里、或升职时目标已经是 superadmin）；
 *   - 降职时若调用者是 superadmin，还要保证"还有别的 superadmin"
 *     （上游把这条守卫写在 UPDATE 里，所以"改到 0 行"就是"会把最后一个 superadmin 降掉"）。
 *
 * 把区间做成 `kind` 而不是两个数值参数，是因为"升职"与"降职"的区间在边界上
 * 各不相同，两个数值参数会让调用点看不出自己拿到的是哪个区间。
 *
 * 契约源: server/core_group.go::PromoteGroupUsers
 * 契约源: server/core_group.go::DemoteGroupUsers
 */
export function shiftMembershipState(
  db: D1Database,
  tenantId: string,
  groupId: string,
  userId: string,
  now: number,
  options: {
    readonly delta: 1 | -1;
    readonly kind: "promote" | "demote";
    readonly callerState: number;
    readonly requireOtherSuperadmin: boolean;
  },
): Promise<D1Result<{ state: number }>> {
  const range =
    options.kind === "promote"
      ? "state > 0 AND state > ?5 AND state <= ?6"
      : "state >= ?5 AND state < ?6";
  const guard = options.requireOtherSuperadmin
    ? `AND (SELECT COUNT(destination_id) FROM group_edge
              WHERE tenant_id = ?4 AND source_id = ?1 AND destination_id <> ?2 AND state = 0) > 0`
    : "";
  return db
    .prepare(
      `UPDATE group_edge SET state = state ${options.delta > 0 ? "+" : "-"} 1, update_time = ?3
       WHERE tenant_id = ?4
         AND ((source_id = ?1 AND destination_id = ?2 AND ${range})
           OR (source_id = ?2 AND destination_id = ?1 AND ${range}))
       ${guard}
       RETURNING state`,
    )
    .bind(groupId, userId, now, tenantId, options.callerState, GROUP_ROLE.member)
    .all<{ state: number }>();
}
