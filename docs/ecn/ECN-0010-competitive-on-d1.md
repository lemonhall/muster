# ECN-0010: 经济与竞技（钱包 / 排行榜 / 锦标赛）建在 D1 与内存缓存上

## 基本信息

- **ECN 编号**：ECN-0010
- **关联 PRD**：PRD-0001
- **关联 Req ID**：REQ-0001-014（钱包与账本）、REQ-0001-015（排行榜）、
  REQ-0001-016（锦标赛）
- **发现阶段**：v2-competitive（M6）编码中
- **日期**：2026-09-29

## 变更原因

上游这一块由四个部分组成，其中三处依赖"进程内常驻内存"或"Postgres 才有的事务语义"：

1. **定义缓存**：`LeaderboardCache` 把排行榜 / 锦标赛定义放在**进程内存**里，
   由运行时模块通过 `leaderboard_create` / `tournament_create` 写入；
2. **名次缓存**：`LocalLeaderboardRankCache` 是一张**内存跳表**，按 `(leaderboard, expiry)`
   分桶，用 `num_score` 当世代号；由后台调度器周期性 `Fill` 重建；
3. **钱包事务**：`updateWallets` 用 `SELECT ... FOR UPDATE` 锁住要改的行，
   在一个事务里"读完—改完—写回"，任意一步失败整批回滚；
4. **创建面**：排行榜与锦标赛的**唯一**创建入口是运行时模块（Lua / Go），
   客户端 REST 面里没有创建端点。

Cloudflare 上没有"常驻进程"（只有请求与 Cron 触发），也没有交互式事务
（D1 只有原子 `batch()`）。因此四处都要换载体，而**对外可观测的行为一条都不能变**。

## 变更内容

### 原设计

| 上游构件 | 职责 | 载体 |
|---|---|---|
| `LeaderboardCache` | 排行榜 / 锦标赛定义 + 目录 | 进程内存 |
| `LocalLeaderboardRankCache` | 名次（跳表 + 世代号 + 过期分桶） | 进程内存 |
| 后台调度器 | 周期重建名次缓存、推进重置周期 | 进程内 goroutine |
| `leaderboard` / `leaderboard_record` | 定义与记录 | Postgres |
| `users.wallet` / `wallet_ledger` | 钱包与账本 | Postgres（jsonb） |
| `updateWallets` | 钱包批量更新（行锁 + 事务） | Postgres 事务 |
| `calculateTournamentDeadlines` | 当期窗口（纯函数） | Go 代码 |
| `cronexpr` | 重置表达式 | 第三方库 |

### 新设计

| 本项目构件 | 对应上游 | 说明 |
|---|---|---|
| `migrations/0004_competitive.sql` | 五张表 / 一个列 | `leaderboard`、`leaderboard_record`、`wallet_ledger`、`users.wallet`、`write_guard` |
| `src/domain/competitive/leaderboard/*` | `core_leaderboard.go` | 定义、游标、存储、列表、haystack、写入、名次缓存 |
| `src/domain/competitive/tournament/*` | `core_tournament.go` | 当期窗口、目录、报名、记录列表 / haystack、写分 |
| `src/domain/competitive/wallet/*` | `core_wallet.go` | 钱包批量更新（CAS + 守卫）、账本 |
| `src/domain/competitive/cron/*` | `internal/cronexpr` | 5 字段 cron 的**受限子集** |
| `src/http/routes/{leaderboard,tournament,competitive-body,tournament-catalog}.ts` | `api_leaderboard.go` / `api_tournament.go` | 10 条端点与逐条文案 |
| `src/wire/competitive.ts` | protojson 线格式 | int64 → 字符串、枚举名、零值省略 |

## 偏差（全部登记在案）

### 偏差 1：定义放 D1 而不是每进程一份内存表

上游把定义放在 `LeaderboardCache` 里，多节点之间靠**运行时模块在每个节点上各注册一次**
来保持一致（注册发生在模块初始化时）。本项目把同一份定义放在 D1 的 `leaderboard` 表里，
于是多个 isolate 天然看到同一份定义，不需要"一致性广播"这条路。

客户端不可见：定义既不进响应体，也没有"列出所有定义"的端点（目录端点只列锦标赛）。

### 偏差 2：cron 只实现实际用到的字段语法子集

上游用 `goriac/cronexpr`，支持 `L`、`W`、`#`、`?`、以及秒级六字段等扩展。本项目只实现
**5 字段 + `*` / `a` / `a-b` / `*/n` / `a-b/n` / `a,b`** 这一组，其余一律在**入库时**报错，
而不是在定时器扫到时抛异常。判定依据是上游自己对重置表达式的用法：`core_tournament_test.go`
的四条用例只覆盖 `*/2`、`0 0 */14 * *`、`* * * * *` 这类形状。
未实现的语法不会被静默当成"永不命中"——这一点比"支持多少语法"更重要。

### 偏差 3：`last(t)` 的语义显式化

上游在 `calculateTournamentDeadlines` 里用 `Next(t.Add(-time.Second)) == t` 判断"现在正好落在
重置点上"，用 `Prev(now)` 取"当期起点"。本项目把这两件事写成 `next()` 与 `last()` 两个方法，
其中 `last(t)` 明确定义为"**不晚于** t 的最近一个命中时刻"——这是从上游那段比较逻辑
反推出来的唯一自洽定义，写进接口名里比留在注释里安全。

### 偏差 4：`max_size` 用 `0` 表示"没有名额上限"

上游用 `MaxSize != math.MaxInt32` 判 `HasMaxSize`，也就是拿**哨兵值**表示"没有上限"。
本项目用 `0`：D1 的 `INTEGER` 装得下 `MaxInt32`，但 `0` 在"人数"这个语义上更诚实，
而且 `size >= max_size` 这类判断不需要先做一次哨兵比较。可观测行为一致
（`max_size` 为 0 时 `can_enter` 与满员判定都不考虑名额）。

### 偏差 5：名次缓存是"有序数组 + 世代号"，灌库是懒加载

上游的跳表与本项目的有序数组在**可观测行为**上等价（插入返回名次、`Get` 返回名次、
`Fill` 填名次并返回这一期的总条目数、世代号更小不覆盖）。差别在复杂度：
跳表插入 O(log n)，有序数组插入 O(n) 搬运。

更实质的差别是**谁来灌库**：上游有常驻后台调度器周期性 `Fill`，本项目改成"第一次读到
某个 (排行榜, 期数) 时懒加载一次"。可观测行为与"调度器恰好已经跑过一轮"一致；
代价是**冷启动后的第一次读**要多一次全表扫描（有 `leaderboard_record_list_idx` 兜着）。

### 偏差 6：钱包原子性用 CAS + 守卫语句取代 `SELECT ... FOR UPDATE`

详见 `src/domain/competitive/wallet/store.ts` 的说明。三条语句构成一次原子批次：
`UPDATE ... WHERE wallet = <我读到的旧值>`、`INSERT INTO write_guard SELECT 0 WHERE changes() = 0`、
账本 `INSERT`。CAS 失败就让整个批次回滚，上层重读重算（同租户内串行）。

可观测差异只有一条：上游在行锁上等待，本项目在重试循环里等待——两端最终都收敛到同一个值
（上游用例的终值 984 与 0 都被逐条复现），但**高并发下的失败率分布不同**。

### 偏差 7：钱包数值是 JS `number`

上游 `wallet` 的值是 int64。本项目用 JS `number`（双精度），安全整数上限 2^53。
超过 2^53 的余额在两边都会失真（上游是"能存不能精确算"，本项目是"存进去就已经不精确"），
所以这一条不是"我们差一点"，而是**同一处边界的两侧**。

### 偏差 8：时间精度到秒

与 ECN-0008 偏差 2 同源：`leaderboard_record.create_time` / `update_time` / `expiry_time`、
`leaderboard.start_time` / `end_time` 都存 Unix 秒。客户端可见的差异只有一条：
同一秒内写入的多条记录，客户端看到的 `create_time` / `update_time` 相同，
排序退化成按 `(score, subscore, owner_id)` 这个元组（这本来就是列表的排序键）。
游标里的 `rank` / `expiryTime` 也随之为秒级精度，不影响翻页正确性。

### 偏差 9：锦标赛目录的坏游标回 400，上游回 500

上游 `TournamentList` 把任何错误都吞成 `Internal`，于是"客户端传了一个坏游标"被报成
服务端故障。本项目回 `400 Cursor is invalid or expired.`——这是**有意的行为改进**，
不是抄错。上游另两处同类端点（排行榜列表、通知列表）本来就是 400，只有这一处自相矛盾。

### 偏差 10：创建面与权威写路径未开放

上游排行榜 / 锦标赛的创建入口是运行时模块（`nk.leaderboard_create` /
`nk.tournament_create`），权威写分走 server key 那条路径（`callerId = uuid.Nil`）。
本项目在 M6 里没有做运行时模块面（那是 M8 的范围），因此：

- **创建**：测试与运维直接写 `leaderboard` 表（`tests/helpers/competitive-world.ts`）；
- **权威写**：`authoritative = 1` 的榜上，任何带用户身份的写分 / 删分都被拒
  （403 `... only allows authoritative score submissions.`），与上游**同一个账号**看到的一样。

客户端可见差异只有一条：`authoritative = 1` 的榜在 M6 里**没有人**能写分。
上游有 server key 的调用方能写。这条在 M8 落地运行时面时关闭。

### 偏差 11：锦标赛目录的排序键是 `(create_time, id)`

上游的目录顺序是 `LeaderboardCache` 的**内存插入序**（`list` 切片的追加顺序），
本项目按 `(create_time, id)` 排。两者在"后创建的排在后面"这一点上一致；
差异只在**同一秒内创建的两个锦标赛**之间：上游按注册顺序，本项目按 id 字典序。
分页游标因此同样不可与上游互换。

### 偏差 12：账本游标不带 `after` / `before`，也不校验跨用户

上游的 `walletLedgerListCursor` 里带着 `UserId` / `After` / `Before`，解码时会比对三者，
"换了时间窗或换了用户再拿旧游标"一律判非法。本项目的 `LedgerCursor` 只有
`(userId, createTime, id, isNext)`，查询本身用当前请求的 `userId` 与时间窗，
所以旧游标在新时间窗下会"照新窗过滤"而不是报错。

进这一条的原因是账本的 REST 面属于**控制台 API**（`server/console_account.go::GetWalletLedger`），
而 M6 只做到存储层（`src/domain/competitive/wallet/store.ts`）。M9 接控制台面时
必须把这个校验补齐——这条偏差就是那个待办的门禁。

## 影响范围

- 受影响的 Req ID：REQ-0001-014、REQ-0001-015、REQ-0001-016。
- 受影响的代码：`migrations/0004_competitive.sql`、`src/domain/competitive/**`、
  `src/http/routes/{leaderboard,tournament,competitive-body,tournament-catalog}.ts`、
  `src/wire/competitive.ts`、`src/index.ts`、`src/http/errors.ts`（新增
  `failedPrecondition`）。
- 受影响的测试：`tests/unit/competitive/`（5 个文件）、
  `tests/integration/competitive/`（4 个文件）、`tests/e2e/competitive.e2e.test.ts`、
  `tests/helpers/{competitive-world,wallet-values}.ts`。
- 不受影响：身份、存储、实时、频道、社交四块的语义与线格式。

## 处置方式

- [x] PRD 已同步更新（REQ-0001-014 / 015 / 016 的偏差备注）
- [x] vN 计划已同步更新（ECN 索引、M6 追溯矩阵、M6 Review 记录）
- [x] 追溯矩阵已同步更新（M6 的两条上游用例转 `ported`，`TestLeaderboardScheduler` 走豁免）
- [x] 相关测试已同步更新（集成 4 个文件 + E2E 1 个文件）
