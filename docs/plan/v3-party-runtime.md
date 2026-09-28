# v3 计划 — M8 派对与运行时扩展

| 项目 | 内容 |
|---|---|
| 版本 | v3 |
| 里程碑 | M8 |
| 日期 | 2026-09-29 |
| 状态 | 进行中（DoD 已冻结） |
| 成本档位 | `standard`（普通功能交付，最多 3 轮 Review） |
| 需求基线 | [PRD-0001](../prd/PRD-0001-muster-parity.md) |
| 上一版 | [v2-index.md](./v2-index.md) |

## 目标

v2 交付之后，muster 已经能跑真游戏：身份、存储、实时、频道、社交、经济竞技、匹配与对局。
v3 补上的是**最后两块让平台真正"可二次开发"的东西**：

1. **派对（party）**：客户端自组织的临时小队，队长可以把整队当一张票投进匹配池。
2. **运行时扩展**：运营方把自己写的游戏逻辑（RPC、前后置 hook）放进平台，平台把它装载进
   沙箱执行——这是"一个后端能承载多个游戏"的必要条件，也是多租户的第二步
   （租户之间不仅数据隔离，**代码也隔离**）。

## PRD Trace

| Req ID | 条目 | 本里程碑交付的部分 |
|---|---|---|
| REQ-0001-019 | 派对：创建、加入请求、批准、踢人、转移队长、关闭、数据广播、标签 | 全部（派对域、实时面、`GET /v2/party` 目录面、派对匹配） |
| REQ-0001-020 | 运行时扩展：RPC 注册、前后置 hook、存储/排行榜 API、隔离与配额 | RPC 注册与调用面、四类 hook、`nk` 工具与数据面 API、**隔离**（独立 isolate + 租户级能力）。配额（CPU/子请求上限）以 workerd 的 `limits` 参数落位，见 ECN-0012 偏差 9 |

## 范围

- 派对域：`src/domain/party/*`、`src/durable/party*.ts`、`src/realtime/pipeline-party.ts`、
  `src/http/routes/party.ts`。
- 派对域的载体选择与五条登记在案的偏差见
  [ECN-0013](../ecn/ECN-0013-party-on-durable-objects.md)（状态落 DO SQLite、目录换 D1、
  游标换 `base64url(JSON)`、标签语法细节、断连清待批请求）。
- 运行时域：`src/runtime/*`（日志、工具函数、bit32、冻结、模块仓、装载器、能力桥、RPC 面）。
- 新增迁移 `migrations/0006_runtime.sql`：租户模块表（源码即数据，人能直接 `SELECT` 出来读）。
- 新绑定：`LOADER`（Worker Loader，见 [ECN-0012](../ecn/ECN-0012-runtime-modules-on-worker-loader.md)）。

不在本里程碑范围内（有明确去处）：

- 对局 tick 循环、`registerMatch`（M7 偏差 11 的后半段）：留到 M9 之后的运行时增量，
  因为它的载体是"对局 DO 里的高频率定时器"，与 M8 的"请求驱动的模块宿主"是两套东西；
  覆盖矩阵里已由 `runtime_test.go` 之外的条目承接，M8 不声明它。
- Lua 模块：上游的 Lua 引擎（`internal/gopher-lua`）在覆盖矩阵里单独归 `LUA` 桶，
  明确"不属于 v1~v4"；本里程碑的运行时是 JS 模块（理由与偏差见 ECN-0012）。
- 管理台、内购、运维指标：M9（v4）。

## DoD（逐条可判定 + 验证命令 + 反作弊）

| # | DoD | 验证命令 | 预期 |
|---|---|---|---|
| 1 | 派对状态机：创建（开放/私有、label、max_size）、开放直接加入、私有产生加入请求并给队长送 `party_join_request`、接受与拒绝、踢人、提拔、关闭、标签更新、数据广播不回显发送者、队长离开 → 最旧成员继任并发 `party_leader`、全员离开 → `party_close` 广播并关闭 | `npm test` | 断言全绿（含每条拒绝路径的文案） |
| 2 | `TestPartyMatchmakerAddAndRemove` 搬运：队长用 `min=1 / max=1` 把**整个派对当一张票**投入匹配池（票面 `party_id` = 派对 id），成员变动自动退票；非队长调用被拒 | `npm test` | 断言全绿；覆盖矩阵第 124 条 `ported` |
| 3 | 派对目录 `GET /v2/party`：`limit` 1..100 与逐字文案、`open` / `label` / `min_size` / `max_size` 四个过滤器、`cursor` 翻页；隐藏派对不进目录 | `npm test` | 断言全绿；错误体形状 `{code, message}` |
| 4 | 模块调用契约：租户模块按 ES module 存 D1（`runtime_modules`），经 `LOADER` 装载进独立 isolate；入口是 `InitModule(ctx, logger, nk, initializer)`；**同一个 isolate 内 `InitModule` 只执行一次**（模块级状态跨调用保留） | `npm test` | 断言全绿（用"调用两次，模块级计数器为 2"钉住只装载一次） |
| 5 | 隔离性：每个租户的 `nk` 能力由宿主按租户闭包构造；模块内 `fetch` / `process` / `require` / `import("node:fs")` 一律不可用（`globalOutbound: null`）；A 租户模块读不到 B 租户的存储对象 | `npm test` | 断言全绿（含"跨租户读取返回空"的负向断言） |
| 6 | `nk` 工具面逐条搬运上游断言：`md5Hash("test")` = `098f6bcd4621d373cade4e832627b4f6`、`sha256Hash("test")` = `9f86d0...0a08`、base64 / base64Url / base16 往返、AES-128 往返、`uuidv4` 形状、`bit32` 的 12 个用例族（含 `lrotate`/`rshift`/`extract`/`replace` 与越界强制） | `npm test` | 断言全绿；覆盖矩阵第 139–144、148–149、164 条 `ported` |
| 7 | `nk.bcryptHash` / `bcryptCompare`：哈希可自校验、错口令返回 false、哈希串不等于明文（偏差：用 PBKDF2-SHA256 取代 bcrypt，理由见 ECN-0012 偏差 6 与 [ECN-0002](../ecn/ECN-0002-password-hash.md)） | `npm test` | 断言全绿；覆盖矩阵第 142–143 条 `ported` |
| 8 | 数据面 API 落到既有服务：`storageRead` / `storageWrite` / `walletUpdate` / `notificationsSend` / `notificationSend` / `notificationsDelete` / `groupCreate` / `groupUpdate` / `groupDelete` / `groupUsersList` / `userGroupsList`；断言读的是**库里的行**，不是返回值 | `npm test` | 断言全绿；覆盖矩阵第 146、150–152、165–167 条 `ported` |
| 9 | RPC：`initializer.registerRpc(name, fn)` + `POST`/`GET /v2/rpc/{id}`（用户令牌与 `http_key` 两条通道），上行非 JSON payload 按字符串编码，回包形状 `{"payload":<json>}` | `npm test` | 断言全绿；覆盖矩阵第 153–154 条 `ported` |
| 10 | Hook：`registerBefore` / `registerAfter`（HTTP 操作名，如 `WriteStorageObjects`）与 `registerRtBefore` / `registerRtAfter`（实时操作名，如 `MatchCreate`）；before 返回 falsy → 请求被拒且**不产生副作用**；after 能读 `ctx.userId` 并写钱包 | `npm test` | 断言全绿；覆盖矩阵第 155–157、161–162 条 `ported` |
| 11 | 日志：宿主侧结构化日志（`runtime: "go"` 字段恒在、`withField` / `withFields` 返回新 logger、`Fields()` 不暴露 `runtime`）；隔离区 `logger` 支持 `%s` 格式化与 `withField` / `withFields` | `npm test` | 断言全绿；覆盖矩阵第 125–137 条 `ported` |
| 12 | 冻结全局：`freezeGlobals` 之后全局命名空间不可新增、既有全局对象不可改、冻结后新建的对象仍可变（JS 语义等价面，引擎差异记 ECN-0012 偏差 8） | `npm test` | 断言全绿；覆盖矩阵第 138 条 `ported` |
| 13 | E2E：真实 HTTP/WS 链路上"派对创建 → 加入请求 → 接受 → 数据广播 → 踢人 → 关闭"，以及"注册 RPC → 客户端调用 → 拿到 payload" | `npm run e2e` | 退出码 0 |
| 14 | 覆盖矩阵中 M8 的 44 条 `planned` 清零（`ported` 或带非空理由的豁免）；ECN-0012 在 PRD / 计划 / 覆盖矩阵三处可追 | `npm run conformance:matrix` + `npm run docs:check` | M8 段 `planned=0`；`unreasoned_exemptions=0`；docs 检查 `problems=0` |

### 反作弊条款

- 第 2 条必须断言**票面里的 `party_id`**（不是"调用没报错"），并且必须构造"队长换人之后再退票"的场景，
  否则"成员变动自动退票"只是一句没有证据的话。
- 第 4 条的"只装载一次"必须用**模块级可变状态**钉住（第一次调用写 +1、第二次读回 2），
  不允许用"第二次调用没报错"代替。
- 第 5 条的跨租户负向断言必须是**同一个用户 id、同一个集合**在两个租户下各写一份，
  然后断言互相读不到；只断言"能写进去"不算隔离。
- 第 8 条的断言必须读库里的行（D1 `SELECT` 或既有域服务的读接口），不允许只看 `nk.*` 的返回值。
- 第 10 条的"被拒且不产生副作用"必须同时断言**HTTP/WS 层的拒绝**与**库里没有新行**。
- 第 1、4、5 条必须先红后绿，红/绿输出粘到本文件的 Evidence 段。

## 文件清单（落地后回填）

| 区域 | 文件 |
|---|---|
| 派对域 | `src/domain/party/{types,ids,errors,members,catalog,matchmaker,store}.ts` |
| 派对运行时载体 | `src/durable/party.ts`、`src/durable/party-{call,members,envelope}.ts`、`src/durable/party-registry.ts` |
| 派对接入面 | `src/realtime/pipeline-party.ts`、`src/http/routes/party.ts` |
| 运行时域（宿主侧） | `src/runtime/{log,freeze,bit32,crypto,aes-cfb,json}.ts` |
| 运行时域（隔离区侧） | `src/runtime/js-logger.ts`、`src/runtime/modules.ts` |
| 运行时域（装载与桥） | `src/runtime/{loader,bridge,service,host,hooks}.ts` |
| 运行时域（能力面） | `src/runtime/{capability,capability-tools,capability-data,capability-groups}.ts` |
| 运行时接入面 | `src/http/routes/rpc.ts`、`src/realtime/pipeline-hooks.ts` |
| 迁移 | `migrations/0006_runtime.sql` |

> 与规划时的差别：`rpc-call.ts` 在落地时拆成 `src/http/routes/rpc.ts`（HTTP 面）
> 与 `src/runtime/host.ts`（把入参译成模块调用），能力面按"工具 / 数据 / 群组"拆成
> 三个不超过 300 行的文件。这里如实回填，不再保留规划名。

## 风险

| 风险 | 影响 | 处置 |
|---|---|---|
| Worker Loader 是较新的 API，线上可用性依赖账号能力 | 线上可能装载失败 | 本地 workerd 已验证；装载失败一律返回明确的 501/500，不静默降级为"没有模块" |
| 跨 isolate 的 RPC 是异步的，而上游 `nk.*` 是同步的 | 模块作者必须给每个 `nk` 调用加 `await` | 登记为 ECN-0012 偏差 2；测试全部按异步写，并在 SDK 文档段里说明 |
| 模块源码存 D1，装载时要拼装 | 装载路径的 CPU 成本 | 按 `tenant:revision` 缓存 isolate；同一 revision 只拼装一次 |
| 派对的实时面较大（11 种 envelope） | 单文件失控风险 | 按 `party-*` 分文件，保持每个文件 ≤300 行 |

## Evidence

逐条 DoD 的证据（红 → 绿输出、命令、数字）在里程碑收尾时回填到本节。

### DoD 1（派对状态机）红 → 绿

红色探针：把两处机制各临时摘掉一小段——
① `src/durable/party-delivery.ts::destroy()` 里的 `this.members.clearMeta()`；
② `src/durable/party-core.ts::join()` 结尾那条带 cid 的空信封。

```
$ npx vitest run tests/integration/party/lifecycle.test.ts --reporter=verbose
 × test_open_join_tracks_the_new_member_and_tells_everyone
 × test_promote_moves_the_leadership_and_broadcasts_it
 × test_remove_kicks_a_member_and_sends_them_a_party_close
 × test_the_oldest_member_takes_over_when_the_leader_leaves
 × test_the_last_member_leaving_destroys_the_party_without_a_close
   → AssertionError: expected true to be false // Object.is equality
 × test_close_broadcasts_party_close_to_everyone_and_removes_the_party
   → Error: 3000ms 内没等到目标帧。已收到：party | partyPresenceEvent
 Test Files  1 failed (1)
      Tests  6 failed | 6 passed (12)
```

恢复两处实现后：

```
$ npx vitest run tests/integration/party/lifecycle.test.ts --reporter=verbose
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

红的两条足以说明：缺 cid 信封 → 客户端等不到回执（`party` 帧到了、`ack` 没到），
不清元数据 → 关闭后的派对还能被 `party_join` 加进去。

### DoD 4（`InitModule` 只执行一次）红 → 绿

红色探针：把 `src/runtime/bridge.ts::ensureInit` 开头那句 `if (state.initialized) return;`
摘掉（只摘这一句，别的一行没动）。

```
$ npx vitest run tests/integration/runtime/modules.test.ts --reporter=verbose
 × M8 运行时: 装载一次 > test_init_module_runs_exactly_once_and_module_state_survives
   → expected { initCount: 2, calls: 2 } to deeply equal { initCount: 1, calls: 2 }
 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
```

恢复守卫后：

```
$ npx vitest run tests/integration/runtime/modules.test.ts --reporter=verbose
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

红的那一条正好把两件事分开：`calls` 从 1 走到 2（模块级状态确实跨调用保留，所以它不受影响），
而 `initCount` 变成 2——说明"只初始化一次"这句话由那句守卫负责，不是"看起来像"。

### DoD 5（隔离性）红 → 绿

两个机制各摘一处：
① `src/runtime/loader.ts` 装载参数里的 `globalOutbound: null`（模块于是能自己出网）；
② `src/runtime/service.ts::capabilityOf` 里的 `tenantId` 换成常量（能力对象不再闭在租户上）。

```
$ npx vitest run tests/integration/runtime/modules.test.ts --reporter=verbose
 × M8 运行时: 隔离 > test_a_module_cannot_reach_the_host
   → expected 'allowed' to be 'blocked' // Object.is equality
 × M8 运行时: 隔离 > test_the_same_user_and_collection_in_two_tenants_stay_apart
   → expected [ { from: 'b' } ] to deeply equal [ { from: 'a' } ]
 Test Files  1 failed (1)
      Tests  2 failed | 4 passed (6)
```

第二行的红值值得看一眼：A 租户读到的是 **B 写进去的那一份**——这正是跨租户泄漏的样子，
而不是"两个租户都读不到"。两处机制都恢复后：

```
$ npx vitest run tests/integration/runtime/modules.test.ts --reporter=verbose
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

### DoD 8（数据面）红 → 绿：一次真缺陷 + 一次测试自己的错

第一次跑 `tests/integration/runtime/tools.test.ts` 是 **3 failed | 5 passed**，
两个失败同源、一个不同源：

```
$ npx vitest run tests/integration/runtime/tools.test.ts --reporter=verbose
 × test_storage_read_returns_empty_values_for_empty_objects
   → RPC global-read 失败：RPC stub used after being disposed.
 × test_notifications_delete_removes_the_row
   → RPC notify-delete 失败：RPC stub used after being disposed.
 × test_group_create_update_list_delete_round_trip
   → D1_ERROR: no such column: group_id at offset 54: SQLITE_ERROR
      Tests  3 failed | 5 passed (8)
```

1. **真缺陷（产品）**：前两条是桥的调用约定错了。桥当时给 handler 传的是 `(ctx, payload)`，
   于是模块只能去捕获 `InitModule` 的那一份 `nk`；而那一份背后的 RPC 会话在第一次调用
   结束时就关闭了，第二次调用必然拿到一个已释放的 stub。上游 `RuntimeJS.InvokeFunction`
   拼的入参是 `[ctx, logger, nk, ...payloads]`，桥改成逐位对齐之后这一类模块就能正常工作
   （偏差登记为 [ECN-0012](../ecn/ECN-0012-runtime-modules-on-worker-loader.md) 偏差 14）。
2. **测试自己的错（工装）**：第三条是本文件里的断言写错了列名——`group_edge` 的两列叫
   `source_id` / `destination_id`，不是 `group_id` / `user_id`。修的是测试，不是实现。

修完两处之后：

```
$ npx vitest run tests/integration/runtime/tools.test.ts --reporter=verbose
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

这里刻意把两类红分开写：把"实现错了"和"断言写错了"混成一句"修好了"，
等于把这次唯一的真缺陷从记录里抹掉。
