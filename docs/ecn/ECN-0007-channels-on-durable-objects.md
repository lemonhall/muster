# ECN-0007: 频道与会话内聊天建在"每频道一个 Durable Object"上

## 基本信息

- **ECN 编号**：ECN-0007
- **关联 PRD**：PRD-0001
- **关联 Req ID**：REQ-0001-010（频道与聊天）
- **发现阶段**：v1-realtime-chat（M4）编码中
- **日期**：2026-09-29

## 变更原因

上游的频道实现建立在"一个长驻进程 + 一个 Postgres"这个前提上：

- **成员 presence 在进程内的 map 里**（`server/tracker.go` 的 `LocalTracker`），所有 stream
  共用一张表，按 `(stream, session)` 双向下标；
- **消息与成员在 Postgres**（`server/core_channel.go`），一张 `message` 表装**所有**频道的消息，
  靠 `stream_mode` / `subject` / `descriptor` / `label` 四列区分；
- **广播靠进程内路由**（`router.SendToStream`），它拿着"stream → 连接"的表直接写 socket；
- **连接结束时摘 presence**（`sessionWS.consume` → `tracker.UntrackAll`）。

Cloudflare Workers 上没有"常驻进程内状态"：请求之间只有 Durable Object 有状态，连接必须挂在
DO 上才能跨请求活着。所以频道的成员表、消息表、投递点三件事都要换载体。

## 变更内容

### 原设计

| 上游构件 | 职责 | 生命周期 |
|---|---|---|
| `LocalTracker`（`tracker.go`） | 频道的成员 presence（全部 stream 共用一张表） | 进程生命周期 |
| `message` / `channel` 表（Postgres） | 全部频道的消息与成员资格 | 数据库 |
| `router.SendToStream` | 按 stream 找连接并投递 | 进程内 |
| `sessionWS.consume` → `UntrackAll` | 连接结束时摘掉该会话的全部 presence | 连接退出时 |

### 新设计

| 本项目构件 | 对应上游 | 说明 |
|---|---|---|
| `Channel`（`src/durable/channel.ts`） | 成员表 + 消息表 + 投递点 | **一个频道一个 DO**，实例名 `租户\|频道 id` |
| `ChannelCore` / `ChannelMembers` / `ChannelMessages` | `core_channel.go` 的语义与两张表 | 语义、成员 SQL、消息 SQL 分三层（`channel-core.ts` 258 行） |
| `ChannelFanout` + `deliverToSession` | `router.SendToStream` | 广播经**会话分片 DO** 投递（分片才是连 socket 的那一层） |
| `SessionChannels`（`src/durable/session-channels.ts`） | `LocalTracker.UntrackAll` 的"按会话索引"那一半 | 分片记"我加入了谁"，断开时逐条 `POST /leaveAll` |
| 频道巡检闹钟（`Channel.alarm`） | 无对应物（上游没有） | 见偏差 5 |

为什么"一个频道一个 DO"而不是"一个租户一个 DO"：频道内的消息顺序、成员快照、历史分页都需要
一个**单点定序**的地方，DO 天然提供它。键里带租户则让跨租户隔离由"键即隔离"承担——
`ChannelMembers` / `ChannelMessages` 的 SQL 里因此**没有** `tenant_id` 列（ECN-0001 的那条规矩
在 DO 这一层由实例名承担）。

## 可观测语义逐条对齐

下列各条都有测试钉住（`tests/integration/channel/`、`tests/e2e/realtime-chat.e2e.test.ts`）：

1. **join 回执**：`{ channel_id, self, presences }`；`presences` 是"当前成员，不含隐藏者"，
   且**新加入者看不到自己**（只有非新加入的 join 才把自己算进列表——上游那段特判照抄）。
2. **presence 事件**：`channel_presence_event` 的 `joins` / `leaves` 逐条对齐；hidden 成员的
   presence（快照与事件）不可见，但**消息广播照收**（上游 `queueEvent` 只跳过 presence 事件）。
3. **持久化开关**：`persistence` 是**每条 presence 自己的**（同一个频道里 A 落盘、B 不落盘）。
4. **send 校验顺序**：频道 id 形状 → `content` 必须是 JSON 对象 → 成员表；失败一律
   `BAD_INPUT` **并关闭连接**（上游 `ProcessRequest` 返回 false）。
5. **edit / remove 的权限**：只有发送者本人能改删（`WHERE id = ? AND sender_id = ?`），
   改不动就回上游那句 `Could not find message to update in channel history`；删除是物理删除。
6. **历史分页**：`limit` 缺省 **1**（不是 100）、`forward` 缺省 true、多取一行判 `next_cursor`、
   游标必须属于同一频道与同一方向；`next_cursor` 取**本页最后一条**而不是多取的那一行。
7. **REST 面的校验顺序**：缺 channel_id → limit 越界 → 频道 id 解不出来 → 游标 → 准入 → 查询，
   六条错误文案逐字对齐（`src/http/routes/channel.ts`）。
8. **断开清理**：连接结束（客户端主动关、平台报错、服务端主动关）时摘掉该会话在**所有频道**里的
   presence，并广播 leave——这一条不是新增机制，是上游 `UntrackAll` 的等价物。

## 偏差（全部登记在案）

### 偏差 1：频道游标用 base64url(JSON) 而不是 gob

与存储域同源（[ECN-0004](./ECN-0004-storage-cursor-encoding.md)）。游标对客户端**不透明**，
只有服务端解它，所以不影响任何客户端的互通；真正是契约的是三条可观测行为：形状不对一律
`Cursor is invalid or expired.`、游标里存的是"上一页的最后一条"、`forward` 与"往哪个方向翻"
是两根独立的轴。代价：**本项目与上游的游标不能互换**（把上游发的游标贴过来会解不出来）。

### 偏差 2：消息时间戳是毫秒，且频道内严格单调

上游 `create_time` 是 Postgres `timestamptz`（纳秒），本项目只能存整数（DO 的 SQLite + JS 的
毫秒精度）。这不只是精度问题：排序键是 `(create_time, id)`，同一毫秒内连发的两条如果时间戳
打平，顺序就由随机 uuid 决定——"按顺序发的三条，历史里乱序"会变成随机失败。所以
`ChannelMessages.nextTimestampMs` 保证新消息的时间戳**严格大于**库里已有的最大值（最坏情况被
推后 1ms）。可观测差异只有一条：**同一毫秒内连发时，后一条的时间戳会比真实墙钟晚几毫秒**。

### 偏差 3：私聊请求通知（`NotificationCodeDmRequest`）后置到 M5

上游在**新 presence 首次加入 DM 频道**且对方不在线时，给对方塞一条
`"<用户名> wants to chat"` 的通知（`pipeline_channel.go` 第 88 行起，`Persistent: true`）。
本项目 v1 还没有通知域（REQ-0001-013 属 M5），所以这一次 join **少发一条通知**；
join 的其余语义（回执、presence、后续消息与历史）不受影响。落地位置已经标在
`src/durable/channel-core.ts` 的 join 分支旁，避免这条偏差被当成"忘了做"。

### 偏差 4：群组成员资格后置——v1 没有群组数据模型

上游要求"调用者必须是群组成员（权限位 ≥ 2）"，群组不存在或不是成员都回
`Group not found: Invalid channel target`。本项目 v1 没有群组数据（REQ-0001-012 属 M5），
`canAccessGroup` **如实返回 false**：这与上游面对一个**不存在的群组**时的行为完全一致，
而不是"暂时放行"或"报未实现"。群组数据落地后换实现即可，调用点与错误文案都不用动
（`src/domain/groups/access.ts`、`src/durable/channel-access.ts`）。

### 偏差 5：频道巡检闹钟（上游没有对应机制）

正常路径下不需要它：连接关闭会主动上报。它兜的是"**分片被平台硬杀、没来得及上报**"这一档——
此时频道的成员表里会留下没人能踢掉的幽灵成员。做法是频道 DO 每 60s 向注册表问一次
`POST /alive`（注册表是**唯一**的活性判据，这里不另养一套心跳），把已经不在的会话摘掉并补 leave。
没有成员时撤掉闹钟，DO 可以彻底静下来。

可观测差异：平台硬杀时幽灵成员最多存活一个巡检周期（60s）。另外**问不到注册表时什么都不做**——
宁可留一个幽灵成员，也不要把在线的人误踢出频道。

### 偏差 6：一个频道一个 DO ⇒ 单点上限

上游的频道状态是进程内 map，热点房间的成本由整个进程分摊；本项目把"这个频道的定序权"交给
一个 DO 实例，于是**同一个频道的吞吐上限就是这个 DO 的上限**。v1 先要语义正确，把这条写进已知
上限；v2 用实测数据再决定要不要分片或加中继（跨区域投递优化同样后置）。

### 偏差 7：断开清理是跨 DO 的"尽力而为"调用

上游 `UntrackAll` 是进程内同步调用，不存在"调用失败"这一档。本项目里分片要跨 DO 通知每个
加入过的频道（`POST /leaveAll`），这些调用可能失败；失败只记日志——连接已经没了，没有客户端
可以被告知这次失败。兜底就是偏差 5 的巡检。分片那张"我加入了谁"的表只是**退订清单**，
成员真相始终在频道 DO 里，所以重复通知是幂等的。

## 影响范围

- 受影响的 Req ID：REQ-0001-010（M4 DoD 1/2/3/4/5）。
- 受影响的代码：`src/durable/{channel,channel-core,channel-members,channel-messages,channel-history,
  channel-access,channel-call,channel-fanout,channel-message-edit,delivery,session-channels}.ts`、
  `src/realtime/{channel,channel-ids,channel-cursor,pipeline-channel}.ts`、
  `src/http/routes/channel.ts`、`src/wire/channel.ts`、`wrangler.jsonc`（`CHANNEL` 绑定与 migration）。
- 受影响的测试：`tests/integration/channel/`（6 个文件 / 53 条）、
  `tests/e2e/realtime-chat.e2e.test.ts`（3 条）。
- 不受影响：身份的认证与会话语义、存储域的语义、实时协议骨架（M3）的行为、上游协议的线格式
  （由 `realtime.proto` 生成物提供，本 ECN 不动它）。

## 处置方式

- [x] PRD 已同步更新（REQ-0001-010 的偏差备注）
- [x] vN 计划已同步更新（ECN 索引、M4 追溯矩阵、M4 Review 记录）
- [x] 追溯矩阵已同步更新（ECN 索引；M4 的第二证据源引用 `/v2/channel/{channelId}`）
- [x] 相关测试已同步更新（频道语义 53 条 + E2E 3 条）
