# v2-competitive — 经济与竞技：钱包、排行榜、锦标赛（M6）

## Goal

把"玩家的输赢"补上：谁有多少钱、谁排在谁前面、哪一期锦标赛现在能不能进。
这三件事在上游是 `users.wallet` + `wallet_ledger` 两张表、`leaderboard` +
`leaderboard_record` 两张表、一个进程内的跳表名次缓存、一个进程内的定义缓存，
以及四段纯计算（cron 重置、锦标赛当期窗口、haystack 窗口、并列元组比较）。

客户端能看见的是 10 条 REST 路径与 4 组枚举；看不见但决定正确性的是三件内部机制：
**名次是算出来的而不是查出来的**、**翻页比较键是 `(score, subscore, owner_id)` 三元组**、
**同一期里同一人只有一条记录**。

上游这一块有 25 个测试条目（钱包、锦标赛窗口、名次缓存、调度器、两条 API 用例），
本项目把它们全部搬到本地 workerd 上跑，并补齐一条 E2E 证明路由真的挂在真实 Worker 上。

## PRD Trace

- REQ-0001-014（钱包与账本）
- REQ-0001-015（排行榜：best / incr / set、衰减、重置周期、owner 记录）
- REQ-0001-016（锦标赛：起止、规模、尝试次数、加入与排名）

## Scope

**做**

- 排行榜：`GET/POST/DELETE /v2/leaderboard/{id}`、`GET /v2/leaderboard/{id}/owner/{ownerId}`。
  写入语义 = `BEST` / `SET` / `INCREMENT` / `DECREMENT` 四种 operator，加上请求级的
  `record.operator` 覆盖（`NO_OVERRIDE` 用榜单自己的）。
- 锦标赛：`GET /v2/tournament`、`GET/POST/PUT/DELETE /v2/tournament/{id}`、
  `POST /v2/tournament/{id}/join`、`GET /v2/tournament/{id}/owner/{ownerId}`。
  当期窗口、`max_size`、`max_num_score`、`join_required` 四条约束逐条落地。
- 钱包：批量更新（累加、同批内同一用户累加、负数整体回滚、可选账本行）与账本存储层。
- 名次缓存：有序数组 + 世代号，懒加载灌库；`rank_count` 与 haystack 的名次由它提供。

**不做**

- 运行时模块面（`nk.leaderboard_create` / `nk.tournament_create`）与权威调用者写分：
  M8 的范围。M6 里 `authoritative = 1` 的榜没有任何调用方能写分（见
  [ECN-0010](../ecn/ECN-0010-competitive-on-d1.md) 偏差 10）。
- 控制台的钱包账本端点（`GET /v2/console/...`）：M9 的范围。M6 只交付存储层。
- 排行榜的**创建**REST 端点：上游没有这个端点，本项目也不造。

## Acceptance

见 [v2-index.md](./v2-index.md) 的 M6 DoD（8 条）。

## Files

| 路径 | 作用 |
|---|---|
| `migrations/0004_competitive.sql` | `leaderboard` / `leaderboard_record` / `wallet_ledger` / `users.wallet` / `write_guard` |
| `src/domain/competitive/cron/{field,expression}.ts` | 5 字段 cron 的受限子集、`next` / `last` / `nextN` |
| `src/domain/competitive/leaderboard/{definition,store,context,cursor,record-store,list,haystack,write,rank-cache,cache,scheduler}.ts` | 定义与行形状、SQL、当期判定、游标、记录列表、haystack、写入、名次缓存、懒加载、调度重算 |
| `src/domain/competitive/tournament/{deadlines,catalog,join,records,write}.ts` | 当期窗口纯函数、目录、报名、记录列表 / haystack、写分 |
| `src/domain/competitive/wallet/{types,store,service}.ts` | 钱包类型、CAS 批次、重试循环 |
| `src/domain/competitive/errors.ts` | 领域失败的种类（文案留给 HTTP 层） |
| `src/http/routes/{leaderboard,tournament,competitive-body,tournament-catalog}.ts` | 10 条端点、请求体解析、目录参数与文案 |
| `src/wire/competitive.ts` | protojson 线格式（int64 → 字符串、枚举名、零值省略） |
| `tests/unit/competitive/*.test.ts` | 纯函数与名次缓存的搬运测试 |
| `tests/integration/competitive/*.test.ts` | 钱包、账本、排行榜读写、haystack、锦标赛 |
| `tests/e2e/competitive.e2e.test.ts` | 真实 HTTP 面的路由注册与错误形状 |

## Steps

1. **红→绿**：cron 子集 + 锦标赛当期窗口 + 名次缓存 + 调度重算（`tests/unit/competitive/`）。
2. **红→绿**：钱包 CAS 批次与账本（`tests/integration/competitive/wallet.test.ts`）。
3. **红→绿**：排行榜记录列表 / haystack / 写入（`leaderboard*.test.ts`）。
4. **红→绿**：锦标赛目录 / 报名 / 写分（`tournament*.test.ts`）。
5. **E2E**：真实 HTTP 面的路由注册与错误形状。
6. **覆盖矩阵与文档回填**：M6 段落转 `ported`，调度器那条走豁免，回填 ECN-0010。

## Risks

| 风险 | 缓解 |
|---|---|
| haystack 的两段取数与"从尾部切窗口"极易抄错（上游真的错过一次，`prev_cursor = next_cursor`） | 用例逐条钉住：中间 / 榜首 / 榜尾三个位置 + 两个游标各自翻出哪一条；游标不相等是显式断言 |
| 名次缓存的世代号语义（只有更大才覆盖）容易写成"总是覆盖" | 缓存单元的 `Insert_Existing` 用例 + 真实库里"同分反复提交"两条路径都断言 |
| operator 有两套编号（榜单自己的 0..3 与 `api.Operator` 的 0..4） | 两个常量名分开（`LeaderboardOperator` / `ApiOperator`），并在文件头写明为什么不能共用 |
| 锦标赛不做"更好才更新"过滤（每次提交都 `num_score + 1`），与排行榜相反 | 两个写入函数分开，注释写明差异；锦标赛用例断言"提交两次之后 `num_score` 是 2" |
| D1 没有交互式事务，钱包的原子性靠 CAS + 守卫 | 守卫失败必须整批回滚的用例（`write_guard` + `batch`）与"排在前面的用户也没写进去"的断言 |
| 单文件 300 行上限 | 排行榜拆成 11 个文件、锦标赛 5 个、测试按主题拆；提交前逐个数行 |

## Evidence

每条 DoD 一条，命令与输出都可复现。全部在本机 workerd / 本地 `wrangler dev --local`
上跑，不连任何 Cloudflare 账号资源，因此不产生账单。

### 红/绿证据（反作弊条款：DoD 1 与 DoD 5）

DoD 1（排行榜读写）与 DoD 5（锦标赛 haystack）的用例必须先红后绿。红证据的复现方式
是把 M6 的路由注册摘掉（`src/index.ts` 里不注册 `registerLeaderboardRoutes` /
`registerTournamentRoutes`），跑同一批用例；随后恢复实现再跑同一批。

```text
$ npx vitest run tests/integration/competitive     # 路由未注册
 × tournament-endpoints.test.ts > 四条边界文案逐条对上        → expected 501 to be 400
 × tournament-endpoints.test.ts > 要求报名时：没报名不能写分… → expected 501 to be 400
 × tournament-endpoints.test.ts > 名额上限：第二个报名的人被拒 → expected 501 to be 200
 × tournament-endpoints.test.ts > 权威榜拒绝普通调用者写分    → expected 501 to be 403
 × tournament-endpoints.test.ts > 不存在的锦标赛：…都是 404   → expected 501 to be 404
 × leaderboard.test.ts / leaderboard-haystack.test.ts / tournament.test.ts （全部失败）
 Test Files  4 failed | 2 passed (6)
      Tests  16 failed | 15 passed (31)
```

```text
$ npx vitest run --config vitest.e2e.config.ts tests/e2e/competitive.e2e.test.ts   # 同上
 × test_leaderboard_routes_are_registered_and_report_not_found → expected 501 to be 404
 × test_leaderboard_write_validates_the_record_before_looking_it_up → expected 501 to be 400
 × test_tournament_catalog_and_not_found_messages → expected 501 to be 200
 × test_competitive_routes_require_a_bearer_token → expected 501 to be 401
 Test Files  1 failed (1)
      Tests  4 failed (4)
```

恢复注册之后，同一批用例全绿（数字见下表）。红的那一版拦在同一个原因上：
路由不存在，`Router` 按上游 REST 表回 `501 Not implemented.`——这正是
"用例钉住的是路由与业务，而不是断言写错了"的证据。

### 逐条 DoD

| DoD | 证据 | 命令与结果 |
|---:|---|---|
| 1 | `tests/integration/competitive/leaderboard.test.ts`（4 条：空榜、SET 覆盖后重排、删分、写分回执）+ `leaderboard-haystack.test.ts`（3 条：中间 / 榜首 / 榜尾、`rank_count`、关掉名次后 `rank` 归零）；用例头 `溯源: server/api_leaderboard_test.go::TestApiLeaderboard` | `npm test` → **65 files / 441 tests 全绿**；覆盖矩阵第 64 条 `ported` |
| 2 | 四种 operator 的落点：`SET` 用"覆盖成绩"用例钉住；`BEST` / `INCREMENT` / `DECREMENT` 的 SQL 分支在 `src/domain/competitive/leaderboard/write.ts`，由 `tests/unit/competitive/` 与锦标赛写分用例共同覆盖 | 同上；operator 两套编号（`LeaderboardOperator` 0..3 / `ApiOperator` 0..4）在文件头逐条写明 |
| 3 | 重置周期：`tests/unit/competitive/leaderboard-scheduler.test.ts`（`computeNext` 推下一跳）+ `tournament-deadlines.test.ts`（`calculateTournamentDeadlines` 的 4 条上游用例）；游标里的 `expiryTime` 与请求不一致判非法 | 同上；覆盖矩阵第 66–69、87–88 条 `ported` |
| 4 | 名次缓存：`tests/unit/competitive/rank-cache-{insert,mutate,lifecycle}.test.ts`（上游 9 条逐条搬运，含 `Insert_Existing` 的世代号语义、`Fill` 的返回是"这一期总条目数"、过期分桶与排行榜隔离） | 同上；覆盖矩阵第 77–85 条 `ported` |
| 5 | `tests/integration/competitive/tournament.test.ts`（haystack：中间页 40 / 30 / 20、`prev_cursor` 翻出 50、`next_cursor` 翻出 10、两个游标不相等、记录列表默认 `limit=10`）；用例头 `溯源: server/api_tournament_test.go::TestApiTournamentHaystack` | 同上；覆盖矩阵第 65 条 `ported` |
| 6 | 锦标赛约束：`tests/integration/competitive/tournament-endpoints.test.ts`（目录四条边界文案、默认只列未结束的、`join_required` 未报名写分被拒 / 报名后可写 / 重复报名幂等、`max_size=1` 第二人被拒且不占位、权威榜 403、不存在的锦标赛三条 404）；文案逐字取自 `server/api_tournament.go` 与 swagger 路径表 | 同上；第二证据源段出现 `apigrpc/apigrpc.swagger.json::/v2/tournament` 与 `::/v2/leaderboard/{leaderboardId}` |
| 7 | 钱包与账本：`tests/integration/competitive/wallet.test.ts`（11 条，上游 7 条逐条搬运 + 并发写 + CAS 守卫 + 账本行）+ `wallet-ledger.test.ts`（4 条：倒序取页与多取一条、反向游标取更新行、时间窗过滤、`json_patch` 合并与跨租户改不到） | 同上；覆盖矩阵第 70–76 条 `ported`；ECN-0010 偏差 6 / 7 / 12 |
| 8 | `tests/e2e/competitive.e2e.test.ts`（4 条：三条路由的 404 形状、请求体与 limit 的校验顺序、目录参数与空目录、无令牌 401） | `npm run e2e` 见提交时的 Review 记录；本文件的单跑结果为 `1 file / 4 tests` 全绿 |

### 文档与矩阵

| 项目 | 命令 | 结果 |
|---|---|---|
| 覆盖矩阵 | `npm run conformance:matrix` | M6 桶的 `planned` 只剩调度器那条（走豁免），其余全部 `ported` |
| 文档卫生 | `npm run docs:check` | 退出码 0；ECN-0010 在 PRD、计划、覆盖矩阵三处可追 |
