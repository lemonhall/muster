# ECN-0008: 社交图（好友边 / 群组 / 通知）建在 D1 上

## 基本信息

- **ECN 编号**：ECN-0008
- **关联 PRD**：PRD-0001
- **关联 Req ID**：REQ-0001-011（好友 / 关注 / 拉黑）、REQ-0001-012（群组）、
  REQ-0001-013（通知与收件箱）
- **发现阶段**：v2-social（M5）编码中
- **日期**：2026-09-29

## 变更原因

上游的社交图是三张 Postgres/Cockroach 表 + 一段状态机：

- **好友边**：`user_edge`，**双向写两行**，`state` 取 0 friend / 1 invite_sent /
  2 invite_received / 3 blocked，排序键是 `(state, position)`；
- **群成员边**：`group_edge`，**单向**（source = 群组、destination = 用户），
  `state` 取 0 superadmin / 1 admin / 2 member / 3 join_request / 4 banned，同样按
  `(state, position)` 排序；
- **群组**：`groups`，`edge_count` 有 `CHECK (edge_count >= 1 AND edge_count <= max_count)`，
  删除是"写 `disable_time`"的软删除，且 `id` / `name` 都是全局唯一；
- **通知**：`notification`，主键 `(user_id, create_time, id)`，`create_time` 是
  `TIMESTAMPTZ DEFAULT now()`。

这些表本身没有"Cloudflare 装不下"的东西——D1 是 SQLite，同样的关系模型照样表达得出来。
真正需要换的是**依赖具体数据库特性的四处**：

1. `position` 由 `time.Now().UTC().UnixNano()` 生成（`core_friend.go` 第 586 行等），
   这是一个 64 位纳秒计数；
2. 游标是 `base64(gob(edgeListCursor{State, Position}))`，`position` 原样进游标；
3. 群组名的唯一性是**全局**的（`groups_name_key`）；
4. `CHECK` 约束与 `timestamptz` 精度在 SQLite 上不存在或不同。

## 变更内容

### 原设计

| 上游构件 | 职责 | 载体 |
|---|---|---|
| `user_edge` | 好友边（双向两行）+ `state` / `position` | Postgres |
| `groups` + `group_edge` | 群组属性与成员边（单向） | Postgres |
| `notification` | 收件箱（持久化通知） | Postgres |
| `users.edge_count` | 社交边计数（好友 + 群组） | Postgres 列 |
| `gob` 游标 | 好友列表 / 好友的好友 / 通知列表分页 | 服务端编码 |

### 新设计

| 本项目构件 | 对应上游 | 说明 |
|---|---|---|
| `migrations/0003_social.sql` | 四张表 | `user_edge` / `groups` / `group_edge` / `notifications`，**每张表主键首列都是 `tenant_id`**（ECN-0001） |
| `src/domain/friends/{store,edges,service,mutate,cursor,validate,types}.ts` | `core_friend.go` | 读 SQL / 写 SQL 分文件；状态机在 `mutate.ts`，列表在 `service.ts` |
| `src/domain/groups/*` | `core_group.go` | 群组与成员边、角色矩阵、频道准入 |
| `src/domain/notifications/{store,service,cursor}.ts` | `core_notification.go` | 落库、列表、删除、推送 |
| `src/domain/base64url.ts` | 各域的游标编码 | 公共的 base64url + 长度上限 |
| `src/wire/{friend,group,notification}.ts` | protojson 线格式 | 线格式仍由 `api_pb.ts` 的字段定义决定 |

`position` 换成**每租户单调递增的计数**（`nextPosition` = `MAX(position) + 1`）。
理由不是"更好看"：纳秒时间戳是 1.7e18，超过 JS 的安全整数上限 2^53，放进游标会**静默丢精度**，
而那个精度恰好是分页定位要用的。单调计数与纳秒时间戳在"序号越大越新"这一点上等价。

## 可观测语义逐条对齐

下列各条都有测试钉住（`tests/integration/friends/`、`tests/integration/social/`、
`tests/e2e/social.e2e.test.ts`）：

1. **加好友**：写出双向边 `INVITE_SENT` / `INVITE_RECEIVED`，并给对方一条
   `-2 <username> wants to add you as a friend`；对方回加时**两条边一起**变 `FRIEND`
   并发出 `-3`。只有真正改到两行才发通知（`changes === 2`）。
2. **删好友**：两行都删掉才算解除关系并发出 `-9 <username> removed you as a friend`；
   只删到一行（原本是单方面拉黑）静默处理，删不动是无声的 0 行。
3. **拉黑**：自己的边变 `BLOCKED`（没有就补一条），删掉对方朝向我的非拉黑边，
   双方 `edge_count` 各自维护。被拉黑者之后再加我为好友会被静默忽略。
4. **好友列表**：`ORDER BY state, position`；游标形态是 `(state, position)`，游标里的 state
   与请求的 `state` 过滤不一致时判非法（上游同款）——否则会翻出"越翻越偏"的页。
5. **好友的好友**：排除自己、排除已在好友表里的人（上游 `destination_id != ALL($3::UUID[])`
   展开成 `NOT IN`），`limit` 是**全局累计上限**（不是每个好友各取 limit），
   带游标时只查 `source_id = cursor.sourceId` 的那个好友。
6. **通知列表**：默认 `limit = 1`（上游 `api_notification.go` 第 55 行）、
   `ORDER BY create_time ASC, id ASC`、**空列表也回 `cacheable_cursor`**、
   零点游标（`createTime = 0, id = ""`）是合法输入。
7. **通知删除**：`WHERE user_id = ?`，别人的 id 传进来是无声的 0 行。
8. **投递顺序**：先落库再推送（`registryNotify` → 会话分片）。推送失败不回滚已落库的通知，
   库里那份才是权威。
9. **好友请求的"自己"**：用**规范化后**的 id 做比对（上游在解析后比对），所以
   `ids[]=<自己的大写 UUID>` 与 `usernames[]=<自己的名字>` 走同一条拒绝路径。

## 偏差（全部登记在案）

### 偏差 1：租户列进主键，群组名唯一性从全局降为租户内

ECN-0001 的延续。可观测差异只有一条：**两个"游戏"可以各有一个叫 `Guild` 的群组**，
而上游会撞唯一键。这是多租户的必然结果，不是实现走样。

### 偏差 2：用 TEXT + Unix 秒代替 UUID + timestamptz

id 统一存**大写标准形**（与上游 `uuid.String()` 的输出同形），文本比较与字节比较同序，
所以 `ORDER BY id` 的语义保持一致。时间统一存 Unix 秒，代价是**通知的 `create_time`
精度到秒**：客户端看到的 ISO 时间字符串只有秒。同一秒内的多条通知不会乱序——上游主键
里 `id` 本来就参与排序，本项目同样 `ORDER BY create_time, id`。

### 偏差 3：`position` 用每租户单调计数代替纳秒时间戳

见上文。客户端不可见：`position` 不进 REST 响应，只出现在游标里，而游标对客户端是不透明的。
代价与 ECN-0004 相同——**本项目与上游的游标不能互换**（把上游发的游标贴过来解不出来）。

### 偏差 4：删除即删行，群组 id 因此可以复用

上游软删除（`disable_time`）让"删掉的群组 id"永远不可再被创建；本项目物理删除，
同一个 id 在删除后可以被重新创建。上游这么做的动机是控制台要能看到已删群组（M9 的范围），
而本项目没有这条需求。

### 偏差 5：拉黑不清理私聊频道的在线态

上游 `blockFriend` 最后会 `tracker.UntrackByStream(2.<a>.<b>)`，把两人在该私聊频道里的
presence 一起摘掉（双方客户端立刻收到 leave）。本项目把频道在线态放在频道 DO 里，
拉黑**不**主动踢人：被拉黑的一方会继续留在那个频道里，直到自己断开。
关系本身（边与通知）与上游完全一致，差异只在"已在频道里的连接怎么处理"。

### 偏差 6：通知写库与推送不是同一个事务

上游在数据库事务里写通知，推送发生在事务提交后的同一函数里；本项目写库是 D1 的
`batch()`（自带事务），推送是跨 DO 的尽力而为调用。可观测差异：**推送可能失败而通知仍然存在**
——这正是想要的（客户端下次拉列表就补上了），但极端情况下"在线用户没收到实时帧、库里有"。

### 偏差 7：群组频道系统消息与成员增删不在同一个事务里

上游 `JoinGroup` / `LeaveGroup` / `AddGroupUsers` / `KickGroupUsers` / `BanGroupUsers`
在**一个数据库事务**里同时改成员边与写群频道的系统消息（`message` 表）。
本项目把成员边放在 D1，把群频道消息放在频道 DO，两者是**两个不同的存储**，没有跨原语事务：
先提交成员变更的 `batch()`，再 fire-and-forget 地往频道 DO 写系统消息。

可观测差异：极端情况下（提交成功、跨 DO 调用失败）成员关系已成立，但群里少了一条
"XX 加入了群组"。选择偏向"关系必须成立"——上游同样是 fire-and-forget 的语义
（`router.SendToStream` 不返回错误），所以这与其说是偏差，不如说是把上游的容错取向
沿到了新载体上。库里的成员关系永远是权威。

### 偏差 8：群组列表游标的 `UpdateTime` 精度到秒

与偏差 2 同源。上游 `GroupListCursor` 里的 `UpdateTime` 是 `UnixNano`，本项目是 Unix 秒。
客户端不可见（游标不透明），但**本项目与上游的群组列表游标同样不可互换**。

### 偏差 9：群目录 `open + langTag` 分支的游标比较方向照"正确语义"写

上游 `core_group.go::ListGroups` 在 `open != nil && langTag != ""` 这一支里，游标比较写成了
`lang_tag > $cursor.langTag AND update_time >= $cursor.updateTime`（字段顺序与另两支相反的
比较方向），翻页时会重复或漏掉边界行。本项目照**列表的实际排序键**（`lang_tag, update_time, id`）
写比较条件，因此这一支的翻页是"不重不漏"的；上游这一支的翻页在有边界行落在同秒时可能重复。

这是一处**有意的行为改进**，不是抄错：上游另两支（`name`、纯 `open`）的比较与本项目一致，
只有这一支自相矛盾，判定为上游笔误。

### 偏差 10：多目标群组操作遇到"满员"时，逐目标原子而不是整体回滚

上游 `AddGroupUsers` 在一个事务里处理全部 `user_ids`：中途发现"群已满"会**整批回滚**，
包括它已经发出去的通知（通知与成员边同库同事务）。
本项目每个目标走一个自己的 `batch()`（D1 的批就是事务），`Group is full.` 之前已经处理完的
目标保持已生效。可观测差异：**批内多目标 + 容量不足**时，上游"一个都没加进去"，
本项目"前面的加进去了，后面的报满"。上游这种语义在分布式下不可表达（通知走的是另一套存储），
而客户端本来就应当把"部分成功"当作可能结果。

### 偏差 11：`group_edge` 主键不同，封禁 upsert 的冲突目标因此不同

上游 `group_edge` 的主键是 `(source_id, destination_id)`；本项目是
`(tenant_id, source_id, destination_id)`（ECN-0001 的延续）。
封禁时上游用 `INSERT ... ON CONFLICT (source_id, destination_id) DO UPDATE` 把已有边改成
state=4；本项目在同一个 `INSERT ... ON CONFLICT(主键)` 上做同样的事。
冲突键不同但**语义等价**：同一租户内两行的身份判定与上游逐字相同。

### 偏差 12：`UpdateGroup` 的"没有新字段"用显式不等判定，而不是依赖 `changes`

上游用 `UPDATE ... WHERE ...` 的 `rowsAffected == 0` 判"值没变"（Postgres 在 `UPDATE` 命中但
新值与旧值相同时返回 0 行）；SQLite 的 `changes()` 在"命中了行但没有实际改动"时返回 1。
直接照抄会让本项目把"没变化"当成"已更新"，于是本该报
`No new fields in group update.` 的请求静默成功。
本项目的判定写成 `WHERE ... AND (col <> ? OR col IS NULL)`，与上游**可观测行为**一致：
值没变 → `400 No new fields in group update.`。

### 偏差 13：通知表带租户列，上游没有

上游的 `notification` 表没有租户列（一个部署一个游戏）；本项目每张业务表都带 `tenant_id`
且查询必须带租户条件（ECN-0001）。可观测差异只有一条：**同一部署下的两个游戏各自有独立收件箱**，
而上游需要两套部署。这正是多租户的目标，不是实现走样。

### 偏差 14：群成员边的"双向两行"由一条 `INSERT ... UNION ALL ... WHERE NOT EXISTS` 写出

上游 `group_edge` 里"群 → 用户"与"用户 → 群"是两行，用一条两值 `INSERT` 写入（靠唯一键冲突
做幂等）。本项目的派生实现里，两行必须**要么都在、要么都不在**——否则
`edge_count`、`GET /v2/user/{id}/group`、`GET /v2/group/{id}/user` 三处会同时失真。
因此写成一条语句：`INSERT INTO group_edge SELECT * FROM (SELECT ... UNION ALL SELECT ...)
WHERE NOT EXISTS (任一方向已存在)`，由同一个 `batch()` 提交。
可观测行为与上游一致（重复加入是幂等空操作），实现形态不同。

## 影响范围

- 受影响的 Req ID：REQ-0001-011、REQ-0001-012、REQ-0001-013（M5 全部 DoD），
  以及 REQ-0001-010 的两条后置（私聊请求通知、群组频道准入）。
- 受影响的代码：`migrations/0003_social.sql`、`src/domain/friends/*`（7 个文件）、
  `src/domain/groups/*`、`src/domain/notifications/*`（3 个文件）、`src/domain/base64url.ts`、
  `src/http/routes/{friend,group,notification}.ts`、`src/wire/{friend,group,notification}.ts`、
  `src/realtime/notifications.ts`、`src/durable/registry-call.ts`、`src/durable/session-registry.ts`。
- 受影响的测试：`tests/integration/friends/`（4 个文件 / 28 条）、
  `tests/integration/social/`、`tests/integration/groups/`、`tests/integration/notifications/`、
  `tests/e2e/social.e2e.test.ts`，以及 `tests/helpers/social-world.ts`。
- 不受影响：身份的认证与会话语义、存储域的语义、实时协议骨架、频道域的语义与线格式。

## 处置方式

- [x] PRD 已同步更新（REQ-0001-011 / 012 / 013 的偏差备注）
- [x] vN 计划已同步更新（ECN 索引、M5 追溯矩阵、M5 Review 记录）
- [x] 追溯矩阵已同步更新（M5 的第二证据源引用 `/v2/group` 与 `/v2/notification`）
- [x] 相关测试已同步更新（好友 28 条 + 群组 + 通知 + E2E）
