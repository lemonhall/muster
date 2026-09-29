# v4 计划 — M9 管理台与运维面

| 项目 | 内容 |
|---|---|
| 版本 | v4 |
| 里程碑 | M9 |
| 日期 | 2026-09-29 |
| 状态 | 进行中（DoD 已冻结） |
| 成本档位 | `standard`（普通功能交付，最多 3 轮 Review） |
| 需求基线 | [PRD-0001](../prd/PRD-0001-muster-parity.md) |
| 上一版 | [v3-party-runtime.md](./v3-party-runtime.md) |

## 目标

v3 交付之后，muster 已经是一个能跑真游戏的平台：身份、存储、实时、频道、社交、经济竞技、
匹配对局、派对、租户运行时。v4 补的是**运营者视角**的三块，也是"能不能把它交给一个
不是作者的人去运营"的分界：

1. **管理台的最小可信内核**：控制台用户的权限模型（ACL bitmap）与两条最容易写错的授权规则
   （发权限时不能超过自己、重置别人的密码前必须先看目标权限）。
2. **v2 欠下的两笔**：运行时面的排行榜 / 锦标赛创建（`nk.leaderboardCreate` /
   `nk.tournamentCreate`）与控制台的钱包账本端点——它们在 v2 的 ECN-0010 偏差 10/12 里
   明确后置。
3. **运维面**：请求 ID 关联与限流（超限 429）。

## PRD Trace

| Req ID | 条目 | 本里程碑交付的部分 |
|---|---|---|
| REQ-0001-021 | 管理台：用户、账号、存储、排行榜、通知、扩展、配置、指标 | 控制台用户与 ACL（模型 + 授权规则 + 服务层 + 受 server key 保护的管理端点）、账号钱包账本读取 |
| REQ-0001-022 | 内购校验：Apple / Google / Facebook / Huawei / Steam 收据 | 购买校验的端点与可插拔校验面；Apple 传统 verifyReceipt 路径走**注入的传输层**（测试不碰厂商端点）；其余 provider 为配置守卫，登记 ECN-0014 |
| REQ-0001-023 | 运维面：限流、结构化日志、审计、指标导出、多环境 | **验收口径的两条**（可配阈值 + 超限 429；日志含请求 ID 关联）＋ 管理操作的审计行；指标导出与多环境另有去处，见 ECN-0014 |

## 范围

- 控制台 ACL：`src/domain/console/acl/*`（bitmap 权限模型）。
- 控制台用户：`src/domain/console/users/*`（策略、服务、存储）、`migrations/0007_console.sql`。
- 控制台接入面：`src/http/routes/console-*.ts`（受 tenant server key 保护，见 ECN-0014 偏差 1）。
- 运维面：`src/http/request-id.ts`、`src/durable/rate-limiter.ts`（每租户一个限流 DO）、
  `wrangler.jsonc` 新增 `RATE_LIMITER` 绑定与迁移项。
- 运行时面（v2 欠账）：`src/runtime/capability-competitive.ts` 新增
  `leaderboardCreate` / `tournamentCreate` / `walletLedgerList` / `walletLedgerUpdate`。
- 内购：`src/domain/iap/*`（provider 分派 + Apple verifyReceipt + 注入的传输层）。

不在本里程碑范围内（都有明确去处）：

- 控制台 SPA（前端）：上游是本仓库之外的独立前端；本项目的交付物是后端面。
- 上游 console 的会话体系（`console_user` 自己的 JWT + MFA）：本项目用 tenant server key
  做管理面鉴权，差异见 ECN-0014 偏差 1。
- 指标导出（Prometheus 抓取）与"多环境"：本项目没有常驻进程可被抓取，多环境由
  租户 + Cloudflare 环境承担（ECN-0001）。ECN-0014 偏差 2 登记这一条，并已回写 PRD 的
  REQ-0001-023 验收口径。
- Lua 控制台扩展、Hiro/Satori 商业面（NS 桶）：不在 v1~v4。

## DoD（逐条可判定 + 验证命令 + 反作弊）

| # | DoD | 验证命令 | 预期 |
|---|---|---|---|
| 1 | `console/acl/acl_test.go::Test_Permission` 搬运：`Compose` 出的 4 位权限对 4 个查询分别为真、对未授予的位为假；`ACL()` 展开出 `ACCOUNT` 的 read/write 为真而 delete 为假、`ACCOUNT_WALLET` 只有 read、`ACCOUNT_EXPORT` 只有 delete | `npm test` | 断言全绿；覆盖矩阵第 168 条 `ported` |
| 2 | `TestValidateConsoleUserACLGrant` 搬运：授权等于自己 → OK、少于自己 → OK、空权限 → InvalidArgument、管理员权限 → InvalidArgument | `npm test` | 断言全绿；覆盖矩阵第 170 条 `ported` |
| 3 | `TestAddUserRejectsInvalidACLBeforeSideEffects` 搬运：越权 ACL 与空 ACL 都在**产生任何副作用之前**被拒（上游那份测试用"撞到 nil 依赖就 panic"来证明顺序，这里用副作用计数 = 0 来证明） | `npm test` | 断言全绿；覆盖矩阵第 169 条 `ported` |
| 4 | `TestValidateConsoleUserTargetACL` 搬运：目标等于自己 → OK、低于自己 → OK、目标是管理员 → PermissionDenied | `npm test` | 断言全绿；覆盖矩阵第 172 条 `ported` |
| 5 | `TestResetUserPasswordAuthorizesTargetACLBeforeUpdate` 搬运的六格：等于/低于自己 → 发码且**写一次**、读目标 ACL 失败一次 → 重试后成功、目标管理员 → PermissionDenied 且**一次都不写**、目标 ACL 畸形 → Internal 且不写、目标不存在 → NotFound 且不写 | `npm test` | 断言全绿；覆盖矩阵第 171 条 `ported` |
| 6 | 管理面端点：`POST /v2/console/user`（建控制台用户，越权 ACL 在写库前被拒）、`POST /v2/console/user/{username}/password-reset`（先授权后写、返回一次性 code）、`GET /v2/console/account/{id}/wallet-ledger`（`limit` 1..100、`after`/`before` 时间窗、游标分页、非法 user id 与非法 limit 各自独立校验）、`GET /v2/console/user`（列表）。鉴权用 tenant server key | `npm test` + `npm run e2e` | 断言全绿；E2E 在真进程上跑通四条 |
| 7 | 运行时面（关闭 ECN-0010 偏差 10/12）：`nk.leaderboardCreate` / `nk.tournamentCreate` 真把定义写进 D1（断言读库里的行），`nk.walletLedgerList` / `nk.walletLedgerUpdate` 走既有账本存储层；不存在的目标返回上游形状的错误 | `npm test` | 断言全绿 |
| 8 | 请求 ID 关联：每个响应都带 `x-request-id`；客户端给的 `x-request-id` 被沿用；服务端日志行里带同一个 id | `npm test` | 断言全绿（含"沿用客户端 id"与"自造 id 形状"两条） |
| 9 | 限流：阈值可配（`RATE_LIMIT_PER_WINDOW` / `RATE_LIMIT_WINDOW_MS`），超限返回 **429** + `google.rpc.Status` 体 + `retry-after`；窗口滑过后恢复；限流按**租户**隔离（A 租户打满不影响 B 租户） | `npm test` + `npm run e2e` | 断言全绿（E2E 用真 HTTP 打到 429，再用第二个租户证明隔离） |
| 10 | 内购：`POST /v2/iap/purchase/{provider}` 收据校验面——Apple 走 verifyReceipt（注入传输层），伪造收据（厂商回 status != 0）被拒且不带出任何账本副作用；未配置凭据的 provider 返回明确错误；请求体非 JSON / 缺 receipt 各自独立校验 | `npm test` | 断言全绿；错误体形状 `{code, message}` |
| 11 | 覆盖矩阵中 M9 的 5 条 `planned` 清零（`ported` 或带非空理由的豁免）；ECN-0014 在 PRD / 计划 / 覆盖矩阵三处可追 | `npm run conformance:matrix` + `npm run docs:check` | M9 段 `planned=0`；`unreasoned_exemptions=0`；docs 检查 `problems=0` |

### 反作弊条款

- 第 1 条的断言必须**同时**覆盖 `HasAccess` 与 `ACL()` 展开两件事，并且逐格断言（4 个资源 ×
  3 个级别里该真的真、该假的假）；只断言"Compose 出来的位图非空"不算。
- 第 3 条的"没有副作用"必须用**副作用计数**（新建用户数 / 发出的邀请邮件数 / 写库行数）
  断言为 0，不允许用"报错信息看起来对"代替。
- 第 5 条的"授权先于写"必须断言**更新次数**：拒绝那三格的更新次数必须是 0，不能只看状态码。
- 第 6 条的账本端点必须断言 `after`/`before` 的时间窗**真的过滤了行**（构造两行、用一个窗口
  只取到一行），不允许只看"返回 200"。
- 第 7 条必须读**库里的行**（D1 `SELECT`），不允许只看 `nk.*` 的返回值。
- 第 9 条的限流必须证明**是限流而不是别的错误**：断言 429 + 错误体 + `retry-after`，并用
  "同一租户第二个请求在阈值内仍然 200" 做对照。
- 第 1、5、9 条必须先红后绿，红/绿输出粘到本文件的 Evidence 段。

## 文件清单（预期）

| 区域 | 文件 |
|---|---|
| 控制台 ACL | `src/domain/console/acl/{permission,resources}.ts` |
| 控制台用户 | `src/domain/console/users/{policy,service,store}.ts` |
| 控制台接入面 | `src/http/routes/{console-users,console-ledger}.ts` |
| 运维面 | `src/http/request-id.ts`、`src/durable/rate-limiter.ts` |
| 内购 | `src/domain/iap/{types,apple,service}.ts`、`src/http/routes/iap.ts` |
| 运行时面 | `src/runtime/capability-competitive.ts`（创建）、`src/runtime/capability-records.ts`（权威写分）、
`src/runtime/capability-ledger.ts`（钱包账本）、`src/runtime/competitive-args.ts`（参数解析） |
| 迁移 | `migrations/0007_console.sql` |

## 风险

| 风险 | 影响 | 处置 |
|---|---|---|
| 控制台鉴权与上游不同（server key 取代 console JWT） | 不是"等价实现"，是登记在案的偏差 | ECN-0014 偏差 1 写清差别与理由；验收口径是"核心操作可完成" |
| D1 没有 `SELECT ... FOR UPDATE` | "读到的人期间被改了权限"这个竞态无法用行锁堵 | 授权判定与写在同一个 DO/串行化路径上；偏差登记 + 用例钉住顺序 |
| 限流 DO 是新增有状态实体 | 多一个每租户实例与一份迁移 | 桶只活在内存里（不落库），窗口靠闹钟滚动；实测断言"窗口滑过后恢复" |
| 内购的厂商调用不能进测试 | 测试会打到 Apple/Google 真实端点 | 传输层注入：默认实现是真 `fetch`，测试注入假响应；伪造收据用例走假响应 |

## Evidence（红 → 绿）

下面三段是收尾轮在本机复现的原始输出（`npx vitest run <file>`，2026-09-29）。
红态的操作都只改源码一处、跑完立刻还原，还原后 `git diff --stat -- src/` 为空。

### DoD 1 — `Test_Permission` 搬运

红：把 `hasAccess` 里的**逐位比较循环**摘掉，只留"`required` 非空即真"。

```
 ❯ tests/unit/console/acl-permission.test.ts (12 tests | 7 failed) 28ms
     × test_composed_permissions_answer_each_query_individually 15ms
     × test_account_read_write_true_delete_false 3ms
     × test_account_wallet_has_read_only 1ms
     × test_account_export_has_delete_only 1ms
     × test_admin_expansion_covers_every_resource_and_level
     × test_none_expands_to_all_false
     × test_json_round_trips_and_defaults_missing_cells_to_false
 AssertionError: expected '________________' to be '0IAAAAAAAAAAAAAA'
 Tests  7 failed | 5 passed (12)
```

绿：还原循环后

```
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

这 7 格正好是"4 个查询的假侧" + `ACL()` 展开的 3 格——证明断言是**逐格钉**的，
换成"位图非空"式的断言这 7 格不会红。

### DoD 5 — `TestResetUserPasswordAuthorizesTargetACLBeforeUpdate` 搬运

红：把 `validateConsoleUserTargetACL(input.callerPermission, targetRole)` 换成
`void input.callerPermission;`（即"不做目标授权检查"）。

```
 ❯ tests/unit/console/user-reset-acl.test.ts (8 tests | 2 failed) 27ms
     × test_admin_permissions_are_rejected 10ms
     × test_the_denied_cell_carries_the_upstream_message 7ms
 AssertionError: expected +0 to be 7
 AssertionError: expected '' to be 'Cannot reset the password of a user with permissions outside the current session.'
 Tests  2 failed | 6 passed (8)
```

绿：还原调用后

```
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

两格一起红是关键：少了授权的实现既**改了不该改的行**（写次数 0 → 7），
也**给错了话**（文案空）。只看状态码的话第一格骗得过去，第二格骗不过去。

### DoD 9 — 限流

红：先在 `wrangler.jsonc` 配 `RATE_LIMIT_PER_WINDOW=3` 把用例写出来，但**限流还没接**
（请求直接放行）。

```
 ❯ tests/integration/ops/rate-limit.test.ts (5 tests | 5 failed) 349ms
     × test_requests_within_the_threshold_pass_and_the_next_one_is_429 63ms
     × test_the_window_slides_and_the_bucket_refills 62ms
     × test_a_second_tenant_is_not_affected_by_the_first_one_being_exhausted 76ms
     × test_user_routes_are_counted_per_user_inside_the_same_tenant 88ms
     × test_the_rejection_lands_in_the_request_log_for_ops 57ms
 AssertionError: expected 200 to be 429   （5 处，均为同一形状）
 Tests  5 failed (5)
```

绿：`npx vitest run tests/integration/ops`

```
 Test Files  2 passed (2)
      Tests  12 passed (12)
```

（2 个文件 = 请求 ID 7 条 + 限流 5 条；同目录一起跑，顺带证明限流没把请求日志写坏。）

### DoD 6 / 9 的另一半（真 HTTP）

`tests/e2e/console.e2e.test.ts` 5 条、`tests/e2e/ops.e2e.test.ts` 1 条跑在真 `wrangler dev --local`
上；全量 `npm run e2e` 的数字见下面的门禁段。限流那条**必须**在真 HTTP 上打到 429，
因为 429 是由响应头（`retry-after`）与状态码共同判定的，单测里看不到这一层。

### DoD 11 — ECN-0014 的三处可追

覆盖矩阵里只有一种 ECN 锚点：豁免理由（M8 的 `TestRuntimeHTTPRequest` 就是这么指向
ECN-0012 的）。M9 桶是 **5 ported / 0 planned / 0 exempt**，没有需要写理由的条目，
所以第三条腿按 v1 DoD 10 定下的口径核对——`npm run docs:check` 退出码 0，
再人工核对 `docs/ecn/ECN-0014-console-and-ops.md` 的引用面：

- PRD：[REQ-0001-021 / 022 / 023](../prd/PRD-0001-muster-parity.md) 三行都写着偏差号，
  并各自收窄了验收口径；
- 计划：本文件（DoD / 范围 / 风险三处）与 [v2-index.md](./v2-index.md) 的 ECN 索引；
- 矩阵：M9 桶清零 + 每条 `ported` 的证据列指向我们自己的测试文件，
  而那些文件的 `契约源:` / `溯源:` 行双向可查（`derived_citations=162`）。

### DoD 10 的一处自纠

内购面先写测试后跑 `npx vitest run tests/integration/iap`，当时是 `15 passed / 1 failed`：
`test_samsung_and_the_subscription_surface_are_honestly_unimplemented` 断言
`{code: 12, message: "Not implemented."}`，实际拿到 `{code: 12, message: "Method Not Allowed"}`。
**错的是测试断言不是实现**：`/v2/iap/purchase/samsung` 没有注册路由，落回通配目录后才被
方法表拒掉。改断言并在注释里写清两条路径的差别后转绿（16 条）。

## 进度（最终提交点：M9 收尾）

| # | DoD | 状态 | 证据 |
|---|---|---|---|
| 1 | `Test_Permission` 搬运 | 已完成 | `7283993`；`tests/unit/console/acl-permission.test.ts` 12 条；红 7 / 绿 12 |
| 2 | `TestValidateConsoleUserACLGrant` | 已完成 | `7283993`；`tests/unit/console/user-policy.test.ts` |
| 3 | `TestAddUserRejectsInvalidACLBeforeSideEffects` | 已完成 | `7283993`；副作用计数断言（新建数 / 审计行均为 0） |
| 4 | `TestValidateConsoleUserTargetACL` | 已完成 | `7283993`；`user-policy.test.ts` |
| 5 | `TestResetUserPasswordAuthorizesTargetACLBeforeUpdate` | 已完成 | `7283993`；`user-reset-acl.test.ts` 8 条，红 2 / 绿 8，拒绝格写次数 0 |
| 6 | 管理面四条端点 | 已完成 | `bd50b04` + `978e52c`；`tests/integration/console/{users,ledger}.test.ts` 12 条 + `tests/e2e/console.e2e.test.ts` 5 条真 HTTP |
| 7 | 运行时面四条 `nk.*` | 已完成 | `0a6e650`；`tests/integration/runtime/competitive-{create,write}.test.ts` 12 条，断言读库里的行 |
| 8 | 请求 ID 关联 | 已完成 | `a818654`；`tests/integration/ops/request-id.test.ts` 7 条 |
| 9 | 限流 | 已完成 | `b988db7` + `978e52c`；`tests/integration/ops/rate-limit.test.ts` 5 条（红 5 / 绿 5）+ `tests/e2e/ops.e2e.test.ts` 真 HTTP 429 |
| 10 | 内购校验 | 已完成 | `8dc5dff`；`tests/integration/iap/*` 16 条，厂商调用走注入传输层 |
| 11 | 矩阵清零与 ECN 可追 | 已完成 | `7283993`…`45a49b8`；M9 段 `planned=0`、`unreasoned_exemptions=0`、`problems=0`；`docs/reviews/v4-M9.md`、`docs/ecn/ECN-0014-console-and-ops.md`、`v2-index.md` 三处可追 |

门禁数字（收尾轮实跑）：

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 0 错 |
| `npm test` | 113 文件 / 842 条全绿 |
| `npm run e2e` | 13 文件 / 49 条全绿 |
| `npm run conformance:matrix` | `entries=263 ported=170 planned=91 exempt=2 unreasoned_exemptions=0 derived_citations=162`（M9 段 `5 / 5 / 0 / 0`） |
| `npm run docs:check` | `problems=0` |

两处已经落定的偏差收尾（写进 ECN-0010 的两条）：

- 偏差 10 的**创建面**由 `0a6e650` 关闭；同一提交还补上了偏差 10 的另一半
  （`nk.leaderboardRecordWrite` / `leaderboardRecordDelete`，调用者是模块即
  `uuid.Nil`，于是 `authoritative = 1` 的榜"没人能写分"不再成立）。
- 偏差 12 由 `bd50b04` + `0a6e650` 关闭：账本游标带上时间窗并校验用户与时间窗，
  控制台折成 `Internal`，运行时折成 `wallet ledger cursor invalid`。
