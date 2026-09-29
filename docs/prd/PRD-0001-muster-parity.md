# PRD-0001: Muster — 边缘游戏后端（功能对齐参考实现）

| 项目 | 内容 |
|---|---|
| PRD 编号 | PRD-0001 |
| 状态 | 草案（v1 计划据此启动） |
| 日期 | 2026-09-28 |
| 愿景 | [VISION.md](./VISION.md) |
| 关联计划 | `docs/plan/v1-index.md` |

## 1. 参考实现与兼容目标

本项目是**独立重实现**，不是 fork，也不是移植代码。参考实现是 Heroic Labs 的 Nakama（Apache-2.0 授权，Go 编写），本仓库只把它当作**行为契约来源**：

- 对外可观测行为（REST 语义、WebSocket 二进制协议、错误码、字段命名、分页语义）以它为准；
- 内部实现（Go 包结构、SQL schema 细节、内存索引结构）不作为契约，我们按 Cloudflare 原语重新设计；
- 产品命名、包名、域名、文案一律不使用上游名称（见 VISION「品牌与法务边界」）。

从上游仓库本地检出（`E:\development\nakama`，浅克隆）读到的可量化事实：

| 事实 | 数值 | 证据 |
|---|---|---|
| REST 面 | 77 条路径 / 91 个操作 | `apigrpc/apigrpc.swagger.json` |
| 实时协议面 | 1 个 `Envelope` + 51 个消息类型 | `vendor/.../rtapi/realtime.proto` |
| 公开 API 消息定义 | 120 个 message | `vendor/.../api/api.proto` |
| 上游测试套件 | 40 个 `*_test.go`，14,856 行，263 个 `Test*` 函数（分布在 36 个文件；`t.Run` 子用例仅 35 处，说明粒度就是函数级） | `docs/conformance/upstream-inventory.md`（脚本生成） |
| 上游测试方式 | 真实进程 + 真实数据库（Postgres 16.8）+ `go test -race ./...`，由 `docker-compose-tests.yml` 编排 | `docker-compose-tests.yml`, `.github/workflows/tests.yaml` |
| 上游测试形态 | 起真实 HTTP/WS 服务端后按客户端面断言（`httptest` + `TEST_DB_URL` 指向真实库） | `server/api_test.go:NewDB/NewAPIServer` |

**测试分布（决定搬运优先级，也是本项目工作量估算的依据）**

| 领域 | 测试函数数 | 对应里程碑 |
|---|---:|---|
| 存储引擎（`core_storage_test.go` 54 条 + `storage_index_test.go` 3 条） | 57 | M2 |
| 匹配器 `matchmaker_test.go` | 23 | M7 |
| 运行时扩展（`runtime_test.go` 29 + logger 类 13 + `runtime_javascript_test.go` 1） | 43 | M8 |
| Lua 解释器与标准库扩展（`internal/gopher-lua/*`） | 76 | 后置（Lua 运行时） |
| 排行榜（rank cache 9 + scheduler 3 + api 1） | 13 | M6 |
| 对局注册与公共逻辑（`match_registry_test.go` 11 + `match_presence_test.go` 1） | 12 | M7 |
| 钱包 `core_wallet_test.go` | 7 | M6 |
| 算法内部（`internal/skiplist` 3 + `internal/cronexpr` 6） | 9 | 按需（我们自己的数据结构/定时器） |
| 锦标赛（core 4 + api 1） | 5 | M6 |
| 账号/REST 面（`api_test.go`、`social/google_token_audience_test.go`） | 4 | M1 |
| 其他（config、metrics、shutdown、socket_ws、party、friend、satori、console ACL） | 14 | 分散 |

> **统计口径**：上表数字全部来自 `docs/conformance/upstream-inventory.md`（由 `npm run conformance:inventory` 生成，不手写）。
> `npm run docs:check` 会把文档里出现的「NNN 个 `Test*`」「NNN 个 `*_test.go`」与本文件的实际统计对账，对不上就失败。
> 这道闸门有具体来历：最初的 266 是手工统计的，而 PowerShell 的 `Select-String` 默认大小写不敏感，
> 把 `func testScriptDir(...)` 这类**小写**辅助函数也当成了测试函数，于是虚高 3 条；正确值是 263。

**这条分布对我们的启示（必须写进计划，不能回避）**：上游测试的重心在**存储引擎、匹配器、运行时、算法内部**；REST/身份面的单元测试反而很薄（`api_test.go` 只有 1 个测试函数，因为 REST 是由 proto 生成的，主要靠集成面覆盖）。因此身份与协议层的对齐**不能只靠搬运**，必须补上第二证据源：

1. 官方客户端 SDK 的黑盒一致性验收（REQ-0001-024，JS SDK 优先）；
2. 由 `api.proto` + swagger 的字段/路径/返回码定义逐条推导出的契约测试。

两条证据源都必须进覆盖矩阵，避免"上游没测所以我们也测不到"的断链。

## 2. 工程准绳：以上游测试套件为验收标准

**这是本项目的最高工程纪律**：不自己发明"够用就好"的测试标准，而是把上游测试套件当作可执行的规格说明，逐条对齐。

### 2.1 三层对齐法

| 层 | 做法 | 产物 | 硬门禁 |
|---|---|---|---|
| A. 清单化 | 脚本扫描上游仓库，提取测试文件、测试函数、覆盖的 API 面，并记录上游 commit SHA | `docs/conformance/upstream-inventory.md`（脚本生成，禁止手写） | 清单条目数 == 上游 `func Test*` 数；与已提交基线比对，上游漂移时必须显式 `--update` 才能通过 |
| B. 逐条搬运 | 每条上游测试在我们的运行时可复现，标注溯源引用 | `tests/**` 中带 `溯源:` 注释的用例 | 每条用例必须先红后绿，红/绿证据写入计划文档 |
| C. 覆盖审计 | 生成"上游测试 → 我们的测试/显式豁免"矩阵 | `docs/conformance/coverage-matrix.md`（脚本生成） | 允许 `/` 显式豁免情况；豁免必须写理由，无理由豁免由脚本报错 |

### 2.2 对齐维度（必须逐项一致）

1. **HTTP 状态码与错误体形状**：包括校验失败、未授权、未找到、冲突、限流的具体码值与 JSON 字段。
2. **字段命名与序列化**：protojson 风格（`snake_case` 字段名、枚举按数字、时间戳 ISO-8601 字符串、`bytes` 为 base64）。
3. **分页与游标语义**：`cursor` 的不透明性、边界（空结果、单页、跨页无重复无遗漏）。
4. **权限与作用域语义**：存储对象的 owner/read/write 权限判定、群组角色、私有频道。
5. **实时协议**：`Envelope` 二进制帧、op 码、`cid` 相关性、错误码枚举、心跳与超时。
6. **顺序与并发保证**：leaderboard 递增的原子性、同房间消息顺序、presence join/leave 顺序。
7. **时间与 ID 形态**：UUIDv4 大写下划线格式、`create_time`/`update_time` 语义。

### 2.3 豁免规则

上游测试中依赖 Go 内部实现细节、或依赖我们刻意不同的实现路线的用例，可以豁免，但必须：

- 在覆盖矩阵中标注理由（不是"以后再说"）；
- 若对应的是对外可观测行为，则**不允许豁免**，必须改写为等价测试；
- 豁免条目每轮 `vN` 回顾时必须重新过一遍。

## 3. 平台与语言选型（ADR-0001）

**决策：核心运行时用 TypeScript 跑在 workerd；运行时扩展层同时支持 TypeScript 与 Python。**

理由（按权重排序）：

1. **长连接是这套后端的命门**。Durable Object 的 WebSocket 休眠（`ctx.acceptWebSocket` / `webSocketMessage` / `serializeAttachment`）是 JS 原生 API 面，房间/会话要长期挂着且空闲零计费，走这条路的确定性最高。
2. **协议编解码**：`api.proto` + `realtime.proto` 需要用成熟工具生成编解码器（`@bufbuild/protobuf` 或 ts-proto），并在运行时不依赖手写近似实现；JS 侧工具链最稳。
3. **测试基础设施**：`@cloudflare/vitest-pool-workers` 能在本地真实 workerd 里跑集成测试与 E2E。用户本机没有 Docker，而上游测试套件恰恰依赖 Docker + Postgres——我们必须能"无 Docker 复现等价断言"，这条直接决定项目可行性。
4. **Python Workers 的实测约束**：无线程、无 greenlet、Wasm 沙箱 CPU 开销、原生扩展包需要 PyEmscripten wheel。作为**扩展层**（跑用户 RPC 逻辑、AI 调用）完全够用，但作为**高频实时核心**（每帧匹配、消息扇出、排行榜递增）是把风险堆在最关键路径上。
5. **成本**：核心路径的性能与内存直接映射到 Durable Object 请求数与 CPU 时间，进而映射到账单。

被否决的方案：

| 方案 | 否决理由 |
|---|---|
| 全 Python Workers | 实时核心 + 长连接 + 包生态三重风险叠加在命门上；且无法复用 JS 侧最成熟的 DO 休眠/协议工具链 |
| Containers（把 Go 二进制塞进容器） | 失去边缘原语的价值，回到"运维一台服务器"，且冷启动与成本都更差；等于没解决用户痛点 |
| Workers + 外部 Postgres（Hyperdrive 为唯一存储） | 对上游双后端语义友好，但把"自托管数据库"这个包袱又背回来了；作为**可选后端**保留，不作为 v1 唯一路径 |
| 只做 REST，不做 WebSocket | 多人对战、聊天、presence 全在上面，做不出"完整功能面" |

## 4. 架构映射（功能 → Cloudflare 原语）

| 上游能力 | 本项目实现 | 关键理由 |
|---|---|---|
| HTTP REST API（77 路径 / 91 操作） | Workers + 路由层（Hono 或等价） | 天然的请求/响应语义 |
| WebSocket 实时协议（51 消息类型） | Worker `/ws` + 会话注册 DO + 分片 DO（可休眠） | 长连接零空闲成本，单点定序 |
| 账号 / 用户 / 存储对象 / 好友 / 群组 | D1（SQL，`batch()` 原子批） | 关系型查询、二级索引、跨用户查询 |
| 钱包 / 货币账本 | Durable Object + SQLite（真交互式事务） | 单写者 + 事务，账本不允许批内部分成功 |
| 排行榜 / 锦标赛 | DO 分片（热计数、原子递增）+ D1（冷读、排名快照）+ Cron/DO alarm（重置） | 递增要原子，排名要可查询 |
| 匹配器 | 专用 Matchmaker DO（池级单写者）+ alarm 做超时 | 全局匹配需要单点视角与定时器 |
| 对局（authoritative match） | 每局一个 Match DO（SQLite 状态）+ 广播/过滤 | 单点定序、状态落盘、崩溃可恢复 |
| 派对 / 聊天频道 | 每派对/每频道一个 DO | 与上游"单房间状态"模型同构 |
| 通知 / 异步扇出 / 内购校验 | Queues + DO alarm | 削峰、重试、解耦 |
| 大对象存储 / 导入导出 | R2 | 存储值超限与备份场景 |
| 定时重置（排行榜、锦标赛、会话清理） | Cron Triggers + DO alarms | 平台级定时 |
| 运行时扩展（RPC / hooks） | 独立 Worker（Dynamic Workers / dispatch 命名空间）+ service binding；TS 与 Python 皆可 | 用户代码隔离、可独立发布、两种语言都能承载 |
| 管理台 | Workers 静态资源 + 同源 API | 无额外部署面 |
| 指标 / 审计 | Analytics Engine + Tail Workers + 结构化日志 | 可观测性与审计 |

**数据一致性策略**：单写者强一致的实体（钱包、对局、频道、匹配池、会话）落到 Durable Object；跨实体的查询与索引落到 D1；两者之间用"DO 为权威、D1 为读模型"的方式收敛（先写 DO，再按需补写读模型，允许读模型短暂滞后，但不允许权威状态丢失）。

## 5. 需求清单

编号规则 `REQ-0001-NNN`。优先级：P0 = v1 必须；P1 = v2；P2 = 后续版本。

| Req ID | 需求 | 优先级 | 验收口径（可二元判定） |
|---|---|---|---|
| REQ-0001-001 | 项目骨架：仓库、wrangler 配置、workerd 测试运行时、覆盖率与文档卫生脚本 | P0 | `npm test` 退出码 0；`npm run typecheck` 退出码 0；无 Docker 依赖 |
| REQ-0001-002 | 健康检查与根路径，与上游语义一致 | P0 | `GET /healthcheck` 返回 200 且 body 为 `{}`；`GET /` 返回 200 |
| REQ-0001-003 | 设备/邮箱/自定义三种认证方式 + 服务端密钥鉴权 | P0 | 上游 `api_authenticate` 等价断言全绿；错误场景返回码逐条对齐。库内密码哈希算法改用 PBKDF2-SHA256（workerd 无 bcrypt；对外形状不变，见 [ECN-0002](../ecn/ECN-0002-password-hash.md)）。**OAuth/社交登录分支的 Google 一半在 M5 交付**（`social/google_token_audience_test.go` 的 3 条全部搬运）；证书来源从 X.509 PEM 端点换成 JWKS、缓存按 TTL 而非 `NotAfter`（[ECN-0009](../ecn/ECN-0009-google-id-token.md)，含 3 条登记在案的偏差）。Apple / Facebook / Steam / GameCenter 的真实凭据交换仍不在范围内，只留"未配置"守卫 |
| REQ-0001-004 | 会话与令牌：access token、refresh token、过期与登出 | P0 | 过期令牌被拒（401）；refresh 成功换发；登出后原令牌失效。401 挑战头保留 `Bearer realm=` 形状，realm 取值用本项目命名（见 [ECN-0003](../ecn/ECN-0003-www-authenticate-realm.md)） |
| REQ-0001-005 | 用户资料读写：用户名、显示名、头像、metadata、locale、时区、位置 | P0 | 字段级读回一致；非法用户名/重复用户名返回码对齐上游 |
| REQ-0001-006 | 存储引擎：集合/对象 CRUD、owner 与 read/write 权限、version 乐观锁、批量操作、游标分页 | P0 | 权限矩阵用例全绿；游标 1 万条无重复无遗漏；version 冲突返回码对齐。本项目的游标是 base64url(JSON) 而非上游的 gob（不透明令牌，对客户端零影响，见 [ECN-0004](../ecn/ECN-0004-storage-cursor-encoding.md)） |
| REQ-0001-007 | 存储索引（可搜索的存储字段） | P0 | 按索引字段查询返回与上游一致的集合与顺序。索引实现从"内存 bluge 索引"换成"对权威表的声明式查询"（[ECN-0005](../ecn/ECN-0005-storage-index.md)，含 4 条登记在案的偏差：上游批内残留不复刻、淘汰决胜键、并发用例轮数、查询语法子集） |
| REQ-0001-008 | 实时协议骨架：WS 握手、Envelope 编解码、ping/pong、错误帧 | P0 | 用上游 proto 生成的编解码器互通；伪造帧返回对齐的错误码。载体是 Durable Object（[ECN-0006](../ecn/ECN-0006-realtime-on-durable-objects.md)）：`/ws` 与 REST 同 Worker，连接挂在会话分片 DO 上 |
| REQ-0001-009 | 会话注册表与在线状态（status follow/unfollow/presence） | P0 | 多连接下 presence 事件不丢不重；断连清理在超时内完成。状态从上游的进程内 map 换成每租户一个注册表 DO（[ECN-0006](../ecn/ECN-0006-realtime-on-durable-objects.md)，含 5 条登记在案的偏差：保活方式、会话 id、M3 未接通的消息类型、多节点一致性、驱逐恢复的测试覆盖） |
| REQ-0001-010 | 频道与聊天：ROOM / GROUP / DIRECT，持久化、历史、编辑删除、presence | P0 | 上游 `api_channel` 等价断言全绿；历史分页语义一致。频道成员与消息从上游的进程内 tracker + Postgres 单表换成**每频道一个 DO**（[ECN-0007](../ecn/ECN-0007-channels-on-durable-objects.md)，含 7 条登记在案的偏差：游标编码、时间戳精度与单调性、私聊请求通知后置 M5、群组成员资格后置 M5、巡检闹钟、单点上限、断开清理的尽力而为语义） |
| REQ-0001-011 | 好友 / 关注 / 拉黑 | P1 | 上游 `core_friend` 等价断言全绿 |
| REQ-0001-012 | 群组：创建、加入、角色、踢人、封禁、列表 | P1 | 上游 `api_group` 等价断言全绿 |
| REQ-0001-013 | 通知与收件箱 | P1 | 通知列表/删除语义与上游一致 |
| REQ-0001-014 | 钱包与账本（含幂等与事务性） | P1 | 并发扣款不出现负余额；账本可逐笔对账。**M6 交付**：上游 `core_wallet_test.go` 的 7 条全部搬运，另有并发写、CAS 守卫与账本用例；原子性从 `SELECT ... FOR UPDATE` 换成 CAS + 守卫批次，数值用 JS number（[ECN-0010](../ecn/ECN-0010-competitive-on-d1.md) 偏差 6/7）。账本的 REST 面属控制台 API，M9 交付（偏差 12） |
| REQ-0001-015 | 排行榜：best/incr/set 模式、衰减、重置周期、owner 记录 | P1 | 上游 `api_leaderboard` 等价断言全绿；重置后旧周期数据可查。**M6 交付**：`TestApiLeaderboard` 的 5 个子用例搬运，名次缓存用有序数组 + 世代号（[ECN-0010](../ecn/ECN-0010-competitive-on-d1.md) 偏差 5），定义放 D1（偏差 1），cron 只实现受限子集（偏差 2/3）；**创建面**（运行时模块）在 M8（偏差 10） |
| REQ-0001-016 | 锦标赛：起止时间、最大规模、尝试次数、加入/排名 | P1 | 上游 `api_tournament` 等价断言全绿。**M6 交付**：`TestApiTournamentHaystack` 搬运 + 目录 / 报名 / 写分的契约测试；`max_size = 0` 表示无上限（[ECN-0010](../ecn/ECN-0010-competitive-on-d1.md) 偏差 4），目录坏游标改回 400（偏差 9），目录排序键为 `(create_time, id)`（偏差 11） |
| REQ-0001-017 | 匹配器：ticket、查询表达式、数值属性、min/max/count_multiple、超时 | P1 | 上游 `matchmaker` 等价断言全绿（含并发与超时）。**M7 交付**：票据池从"进程内存 + 常驻 ticker"换成**每租户一个 DO**（SQLite + 闹钟，[ECN-0011](../ecn/ECN-0011-match-on-durable-objects.md) 偏差 1），不引入 bluge——查询只实现用得到的子集、打分只算子句 boost 之和（偏差 4），遍历与快照顺序确定化（偏差 5），跨 DO 边界的表示用 protojson 取代 gob（偏差 10）；成局"给 match id 还是给 token"由声明式钩子决定（偏差 11，运行时回调在 M8） |
| REQ-0001-018 | 对局：authoritative match 生命周期、RPC hook、状态落盘、广播过滤、可查询的对局列表 | P1 | 上游 `match_registry`/`match_common` 等价断言全绿。**M7 交付**：成员表与对局元数据住**每场对局一个 DO**（[ECN-0011](../ecn/ECN-0011-match-on-durable-objects.md) 偏差 1/7），目录合并成 D1 的 `match_record` 一张表（偏差 2），权威对局的唯一入口是匹配器钩子（偏差 3），node 段固定 `muster`（偏差 6），同秒排序补 `match_id` 决胜（偏差 8），时间精度到毫秒/秒（偏差 9）；运行时面（`nk.*`、tick 循环、`tick_rate` / `handler_name`）在 M8（偏差 11） |
| REQ-0001-019 | 派对：创建、加入请求、批准、踢人、转移队长、关闭、数据广播、标签 | P1 | 上游 `party_handler` 等价断言全绿。**M8 交付**：派对状态从上游的进程内 map 换成**一个派对一个 DO**（SQLite，[ECN-0013](../ecn/ECN-0013-party-on-durable-objects.md) 偏差 1），目录从 bluge 换成 D1 `party_record` 且排序固定（偏差 2），游标改 `base64url(JSON)` 并存归一后的查询串（偏差 3），标签语法细节来自 JS 引擎（偏差 4），断连时清该会话的待批准请求（偏差 5）；十一条 `party_*` 帧的校验顺序与逐字文案逐行对齐（含三处上游笔误） |
| REQ-0001-020 | 运行时扩展：RPC 注册、前后置 hook、定时器、存储/排行榜 API、隔离与配额 | P1 | 扩展 Worker 可注册 RPC 并被客户端调用；死循环/超限被隔离。**M8 交付**：模块装载从"进程内嵌入式引擎"换成 **Worker Loader 独立 isolate**（[ECN-0012](../ecn/ECN-0012-runtime-modules-on-worker-loader.md)，13 条偏差）：模块源码进 D1、按 `tenant:revision` 缓存 isolate、`globalOutbound: null` 断掉直接出网、`nk.*` 全部异步、只支持 JS(ESM)、bcrypt 换 PBKDF2-SHA256、AES-128-CFB 自实现、配额走 workerd `limits` |
| REQ-0001-021 | 管理台：用户、账号、存储、排行榜、通知、扩展、配置、指标 | P2 | 与上游 console 面等价的核心操作可完成。**M9 交付**：控制台 ACL 位图模型与两条授权规则搬运（覆盖矩阵第 168~172 条），控制台用户的建/重置/列表与钱包账本端点（受 tenant server key 保护，[ECN-0014](../ecn/ECN-0014-console-and-ops.md) 偏差 1）；只覆盖最小可信内核（偏差 6） |
| REQ-0001-022 | 内购校验：Apple / Google / Facebook Instant / Huawei / Samsung 收据 | P2 | 上游 `iap` 等价断言全绿（含伪造收据被拒）。**M9 交付**：provider 分派 + Apple 传统 `verifyReceipt`（走**注入的传输层**，[ECN-0014](../ecn/ECN-0014-console-and-ops.md) 偏差 5），伪造收据被拒且无账本副作用；Google / Huawei / Facebook Instant 为配置守卫，Samsung 与订阅面**不注册**（501，偏差 7）。provider 名单以 `server/api_purchase.go` 的五个 `ValidatePurchase*` 为准（上游没有 Steam 校验面，收据清单此处更正） |
| REQ-0001-023 | 运维面：限流、结构化日志、审计、指标导出、多环境 | P1 | 限流阈值可配且超限返回 429；日志含请求 ID 关联。**M9 交付**：请求 ID 关联（响应头 + 日志）与每租户限流 DO（[ECN-0014](../ecn/ECN-0014-console-and-ops.md) 偏差 4）；验收口径**只取前两条**——指标导出与多环境不在本项目载体上（偏差 2） |
| REQ-0001-024 | 协议兼容验收：官方 JS SDK 与 Godot SDK 不改源码直连 | P0 | 两个 SDK 的示例流程在本项目上跑通，录屏/日志为证 |
| REQ-0001-025 | 成本模型：给出百/千/万级在线的额度与费用估算 | P1 | 文档含可复算的公式与实测数据点 |
| REQ-0001-026 | 多租户：同一部署（一个 Cloudflare 账号）内并行运营多个游戏，彼此数据与令牌完全隔离 | P0 | 同账号下建两个租户：A 租户令牌在 B 租户被拒（401）；同名用户在两个租户下可各自存在；未知 server key 返回 401 `Server key invalid`（详见 [ECN-0001](../ecn/ECN-0001-multi-tenancy.md)） |

## 6. 全局约束

1. **语言**：核心 TypeScript（workerd），扩展层 TS + Python。
2. **无 Docker**：一切测试在本机 workerd 跑通；上游 Docker 依赖只作为行为对照，不作为本项目的运行前置。
3. **协议即资产**：`api.proto` / `realtime.proto` 是兼容基线，编解码必须由工具生成。
4. **命名**：不出现上游产品名（VISION §品牌与法务边界）。
5. **中文写入**：所有含中文的文件用 UTF-8（Windows 下禁止用 PowerShell 5.1 重定向写入）。
6. **外网**：拉取上游/依赖/文档时走本机代理 `127.0.0.1:7897`。
7. **可复现**：任何"完成"声明必须附命令与输出。
8. **多租户**：所有业务数据带 `tenant_id` 且查询必须带租户条件；租户由 server key 或令牌 claim 解析，不允许出现"默认租户"这种隐式回退（详见 [ECN-0001](../ecn/ECN-0001-multi-tenancy.md)）。

## 7. 里程碑归属

| 里程碑 | 覆盖 Req ID | 版本 |
|---|---|---|
| M0 工程地基与一致性工装 | 001, 002 | v1 |
| M1 身份与账号（含多租户） | 003, 004, 005, 026 | v1 |
| M2 存储引擎 | 006, 007 | v1 |
| M3 实时协议骨架与在线状态 | 008, 009 | v1 |
| M4 频道与会话内聊天 | 010 | v1 |
| M5 社交（好友/群组/通知/社交登录令牌校验） | 011, 012, 013，以及 003 的 OAuth 分支 | v2 |
| M6 经济与竞技（钱包/排行榜/锦标赛） | 014, 015, 016 | v2 |
| M7 匹配与对局 | 017, 018 | v2 |
| M8 派对与运行时扩展 | 019, 020 | v3 |
| M9 管理台 / 内购 / 运维面 | 021, 022, 023 | v4 |
| 持续 | 024, 025 | 每个版本复核 |

## 8. 术语表

| 术语 | 含义 |
|---|---|
| 上游 / upstream | 参考实现（Apache-2.0 的开源游戏后端），仅作行为契约来源 |
| 权威状态 | 必须强一致的单一写者状态（钱包、对局、频道、匹配池） |
| 读模型 | 由权威状态派生的、允许短暂滞后的可查询数据（D1 中的索引/列表） |
| 会话注册表 | 记录"用户 ↔ 连接 ↔ 订阅"的全局视图，presence 与状态订阅的权威来源 |
| 搬运 | 把上游测试的场景与断言在我们的运行时下重新实现为可执行测试 |
| 豁免 | 经过论证、不搬运的上游测试，必须在覆盖矩阵中给出理由 |
