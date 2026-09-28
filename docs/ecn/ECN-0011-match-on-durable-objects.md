# ECN-0011: 匹配器与对局建在 Durable Object 与 D1 上

## 基本信息

- **ECN 编号**：ECN-0011
- **关联 PRD**：PRD-0001
- **关联 Req ID**：REQ-0001-017（匹配器）、REQ-0001-018（对局）
- **发现阶段**：v2-match（M7）编码中
- **日期**：2026-09-29

## 变更原因

上游这一块由五个部分组成，其中四处依赖"常驻进程"或"内存索引"：

1. **匹配器**：`LocalMatchmaker` 把票据池放在**进程内存**里，由一个常驻 ticker
   每 `interval_sec` 跑一轮 `processDefault`；成局后由运行时回调决定"给 match id
   还是给 token"；
2. **检索**：票面与对局标签都进 **bluge 内存索引**，查询串靠 lucene 语法检索、
   靠 bm25 打分排序；
3. **对局注册表**：`LocalMatchRegistry` 把权威对局的 `MatchHandler` 与其标签放在
   进程内存 + bluge 索引里；**中继对局**不在那里，靠 `tracker` 的流表数出来；
4. **对局成员**：`MatchPresenceList` 是一张进程内哈希表，随对局生命周期生灭；
5. **跨节点**：多节点之间靠 `matchmaker` 的"net node"与 tracker 的 gossip 保持一致。

Cloudflare 上没有"常驻进程"（只有请求与闹钟），也没有跨实例共享的内存索引。
因此四处都要换载体，而**对外可观测的行为一条都不能变**。

## 变更内容

### 原设计

| 上游构件 | 职责 | 载体 |
|---|---|---|
| `LocalMatchmaker` | 票据池 + ticker + 成局 | 进程内存 + 常驻 goroutine |
| bluge 索引 | 票面检索、对局标签检索与打分 | 进程内存 |
| `LocalMatchRegistry` | 权威对局 handler 与标签 | 进程内存 + bluge |
| `tracker` | 中继对流表 | 进程内存 |
| `MatchPresenceList` | 对局成员表 | 进程内存 |
| 运行时回调 | 成局后决定 match id / token | 扩展进程内的 Lua / Go 模块 |

### 新设计

| 本项目构件 | 对应上游 | 说明 |
|---|---|---|
| `src/durable/matchmaker.ts` + `matchmaker-store.ts` | `LocalMatchmaker` | **每租户一个 DO**（实例名 = 租户 id），票据落 DO 的 SQLite，用闹钟代替 ticker |
| `src/domain/matchmaker/{query,pool,process,stats}.ts` | bluge + `processDefault` | 查询子集 + 洗牌遍历 + 打分（不引入 bluge） |
| `src/durable/match.ts` + `match-members.ts` + `match-core.ts` | `LocalMatchRegistry` + `MatchPresenceList` | **每场对局一个 DO**（实例名 = `租户\|uuid`），成员与元数据同住一个实例 |
| `migrations/0005_match.sql` + `src/domain/match/store.ts` | bluge 索引 + tracker | 目录合并成 D1 的 `match_record` **一张表** |
| `src/durable/matchmaker-hook.ts` | 运行时回调 | **声明式钩子**（`{size, match:{mode,label}}`），够复刻上游用例的判定 |
| `src/domain/match/token.ts` | `jwt.MapClaims{"mid","exp"}` | HS256 令牌，密钥按租户派生（ECN-0001） |
| `src/http/routes/match.ts` + `src/wire/match.ts` | `api_match.go` / `api_matchmaker.go` | 两条端点与逐条文案、protojson 线格式 |

## 偏差（全部登记在案）

### 偏差 1：状态住 DO，而不是进程内存 + 常驻 ticker

上游的票据池、对局成员、对局元数据都是"进程内存里的活对象"。本项目把它们放进两类
DO：**每租户一个匹配器**（键 = 租户 id）、**每场对局一个实例**（键 = `租户|uuid`）。
于是"重启之后票还在不在"的答案与上游不同（这边在，上游不在），而"一轮成局挑谁"
"谁在局里"这些可观测行为完全一致。

匹配器的 ticker 换成**闹钟**：池子空了就 `deleteAlarm`，有新票才
`setAlarm(now + intervalMs)`。这是刻意的差异——空闲租户的匹配器实例不烧时长——
代价是"最后一轮成局成在票到齐之后最多 `intervalMs`"，与上游的 ticker 同形。

客户端不可见（客户端看不见载体），但**崩溃恢复语义可见**：上游进程重启丢票据，
本项目不丢。

### 偏差 2：目录合并成 `match_record` 一张表

上游列对局时走**两条路**：权威对局查 bluge 索引、中继对局数 tracker 的流表，
两条路各有各的坑（索引重建、tracker 只有本节点）。本项目把两类的"对外可见投影"
（id / node / authoritative / label / size / create_time）写进 D1 的 `match_record`，
由**对局 DO 自己在成员变动时同步**，于是列表端点只需读一张表。

一致性上这是更强的形状：`GET /v2/match` 看到的 `size` 与对局成员表永远一致
（上游可能差一拍）。客户端可见的差别只有一条：中继对局在"最后一个成员离开"时
立刻从目录里消失（上游靠 tracker 的生命周期，也在那一刻）。

### 偏差 3：权威对局只有匹配器钩子一个入口

上游的权威对局由**运行时模块**在 `matchmaker_matched` 回调里 `nk.match_create` 建出来，
客户端本身建不了权威对局（`match_create` 帧一定是中继）。本项目在 M7 里把那条回调
换成声明式钩子（偏差 11），于是权威对局的唯一入口是 `src/durable/match-call.ts`
的 `matchCreate`（`/create` 路由）：**建对局但不加入任何人**，谁进谁不进由后续的
`match_join` 决定。运维与测试也走这同一个入口。

### 偏差 4：不引入 bluge——查询只实现用得到的子集，打分只算子句 boost 之和

上游用 bluge 做两张索引（票面属性、对局标签），查询串是 lucene 语法，排序靠 bm25。
本项目自己实现解析与求值（`src/domain/matchmaker/query.ts`）：支持 `*`、
`field:value`、`+` / `-` 前缀、`>=` / `<=` / `>` / `<`、`/regex/`、`^boost`
这七种形状，其余形状在**解析期**报错（而不是静默不匹配）。

打分只把命中子句的 boost 相加，不实现 bm25 的词频 / 字段长度归一化。可观测影响：
**只有"多子句命中时谁排前面"**这一处可能与上游不同；上游的
`TestMatchmakerAddMultipleAndSomeMatchWithBoost` 那类"boost 高的先被选中"的用例
在本项目下逐条成立（因为 boost 之和的顺序与 bm25 在那些用例里一致）。

### 偏差 5：遍历与快照的顺序确定化

上游遍历 Go map 的次序是**随机**的（`processDefault` 里的 map 迭代），
本项目按 `(createdAt, ticket)` 升序遍历、成员表按插入序输出。于是"同样的输入得到
同样的输出"从"通常成立"变成"总是成立"。这不会改变任何一条断言，只会消掉
上游用例里那种"偶尔换个顺序就换一组人成局"的不确定性。

### 偏差 6：node 段固定是 `muster`

上游每个进程有自己的 node 名，match id 是 `<uuid>.<node>`，多节点部署时 node 段
不同。本项目每租户只有一个逻辑节点，权威对局的 node 段固定写 `muster`；
解析时仍然接受任意非空 node（发布出去的 `matchmaker_matched.token` 里的 mid 是
`<uuid>.`，空 node，与上游一致）。

客户端可见：权威对局的 match id 后半段是 `muster` 而不是上游那种主机名——
但 **match id 本来就是对客户端不透明的字符串**（客户端只回传），所以不影响兼容。

### 偏差 7：成员表既能落 DO SQLite，也能当纯内存对象

上游 `MatchPresenceList` 只有"进程内"一种形态。本项目把它写成**同一份语义、
两种载体**：生产路径落对局 DO 的 SQLite（跨请求存活），单元测试里可以纯内存实例化
（不依赖 workerd 的存储）。两类调用方共用同一组方法，语义（`Join` 覆盖、
`Leave` 删除、`ListPresences` 快照、`Size`）只有一份实现。

### 偏差 8：同秒创建的排序决胜项是 `match_id`

上游对局列表的顺序是 `-create_time`（查标签）或 `-_score, -create_time`（查查询串），
**同秒创建的对局顺序在它那里是未定义的**。本项目在末尾补一个 `match_id` 升序决胜项，
于是翻页不会跳过 / 重复。客户端可见的差别只在"同秒创建的两个对局谁先出现"。

### 偏差 9：时间精度——DO 内部毫秒、D1 与线格式到秒

上游用纳秒时间戳。本项目：匹配器票据与成局样本在 DO 内部用**毫秒**
（排序与等待时长都以毫秒比较，纳秒级差异不改变任何可观测行为），落到
`match_record.create_time` 与线格式（RFC3339）时**回到秒**——与上游 API 的
`google.protobuf.Timestamp` 秒精度一致。客户端可见的差别只有"同一秒内创建的
对局排序退化成偏差 8 的决胜项"。

### 偏差 10：跨 DO 边界的帧表示用 protojson（取代 gob）

上游的 match / ticket 记录在跨节点传输时用 **gob** 编码。本项目跨 DO 边界的
往返（分片 DO ↔ 对局 DO / 匹配器 DO）用 **protojson**：`Envelope` 直接按 proto
的 JSON 映射编解码，`op_code` 这种 int64 走十进制字符串、`bytes` 走标准 base64。
等价物是"编码再解码，逐字段相等"（`tests/integration/match/roundtrip.test.ts`
覆盖上游 `TestEncode*` 的三条）。

### 偏差 11：运行时面未开放——声明式钩子取代运行时回调

上游的"成局之后拿到什么"由运行时模块的回调决定（`nk.matchmaker_matched` 里
`nk.match_create`）。本项目在 M7 里没有运行时（M8 的范围），于是把它换成
**声明式钩子**：`POST /hook` 写一份 `{size, match:{mode:"authoritative", label}}`，
匹配器成局时按它判断"这批人该开权威对局还是拿 token"。上游用例
`TestMatchmakerAddAndMatchAuthoritative` 断言的两件事（给的是 match id 还是 token、
那个 id 能不能直接 join）逐条成立。

同一处偏差的另一半：**权威对局的 `tick_rate` 与 `handler_name` 在 M7 里恒为空**。
上游这两个字段来自运行时 handler 的属性，本项目还没有运行时，所以列表端点的
响应里按 protojson 的零值规则**根本不出现这两个键**——形状与"上游某场对局恰好
tick rate 为 0、handler 名为空"一致。

## 影响范围

- 受影响的 Req ID：REQ-0001-017、REQ-0001-018。
- 受影响的代码：`migrations/0005_match.sql`、`src/domain/match/**`、
  `src/domain/matchmaker/**`、`src/durable/{match,match-core,match-members,match-roster,
  match-call,match-shapes,matchmaker,matchmaker-core,matchmaker-store,matchmaker-call,
  matchmaker-hook,session-match}.ts`、`src/realtime/{match,matchmaker,pipeline-match,
  pipeline-matchmaker}.ts`、`src/http/routes/match.ts`、`src/wire/match.ts`、
  `src/index.ts`、`src/env.ts`、`wrangler.jsonc`、`worker-configuration.d.ts`。
- 受影响的测试：`tests/unit/match/`（5 个文件）、`tests/unit/matchmaker/`（2 个文件）、
  `tests/integration/match/`（4 个文件）、`tests/integration/matchmaker/`（2 个文件）、
  `tests/e2e/match.e2e.test.ts`（+ `match-helpers.ts`）、
  `tests/helpers/{match-world,match-service}.ts`。
- 不受影响：身份、存储、实时、频道、社交、经济与竞技六块的语义与线格式。

## 处置方式

- [x] PRD 已同步更新（REQ-0001-017 / 018 的偏差备注）
- [x] vN 计划已同步更新（ECN 索引、M7 追溯矩阵、M7 Review 记录）
- [x] 追溯矩阵已同步更新（M7 的 35 条 `planned` 全部转 `ported`）
- [x] 相关测试已同步更新（单元 7 个文件 + 集成 6 个文件 + E2E 1 个文件）
- [ ] 偏差 11 的后半段（运行时面：`nk.*` 与权威对局的 tick rate / handler 名）
      在 M8 关闭；届时 `src/wire/match.ts` 的注释与本节一起更新
