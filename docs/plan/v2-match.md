# v2-match — 匹配与对局：匹配器、对局实例、可查询的对局目录（M7）

## Goal

把"两个人怎么走到同一局里"这条链补上。上游这一块由四件东西组成：
一个**内存票据池 + 常驻 ticker**（匹配器）、一个**bluge 检索索引**（查询串与打分）、
一个**对局注册表 + 成员表**（谁在哪一局里），以及一条**运行时回调**（成局后给
`match id` 还是给 `token`）。

客户端能看见的是四条实时帧（`matchmaker_add` / `matchmaker_remove` /
`matchmaker_matched` / `match_ticket`）与三条对局帧（`match` / `match_data` /
`match_presence_event`），外加两条 REST 路径（`GET /v2/match`、
`GET /v2/matchmaker/stats`）；看不见但决定正确性的是三件事：
**同一组人的选择必须确定**、**成局帧的 `self` 是收件人自己**、
**`token` 分支的 mid 是"新建中继对局"的指令而不是"必须已存在"**。

上游这一块有 35 个覆盖条目（匹配器 21 条 + 注册表/存在表 12 条 + API 2 条），
本项目把它们全部搬到本地 workerd 上跑，并补齐一条 E2E 证明整条链在真实 Worker 上成立。

## PRD Trace

- REQ-0001-017（匹配器：ticket、查询表达式、数值属性、min/max/count_multiple、超时）
- REQ-0001-018（对局：authoritative match 生命周期、RPC hook、状态落盘、广播过滤、
  可查询的对局列表）

## Scope

**做**

- 匹配器：查询串子集（`*` / `field:value` / `+` / `-` / 区间 / 正则 / `^boost`）、
  票据池（每会话/每派对上限 3 张）、`processDefault` 的选人规则（min/max 相容、
  排自己派对、无会话重叠、`count_multiple` 裁剪、`- score, created_at` 排序）、
  成局后的投递与完成缓冲、`GET /v2/matchmaker/stats`。
- 令牌：HS256、`mid = <uuid>.`、30 秒有效期、按租户派生密钥（ECN-0001）。
- 对局：权威 / 中继两种对局的生命周期，`match_create` / `match_join` / `match_leave` /
  `match_data_send` 四条帧的校验顺序与逐字文案、中继数据的过滤与不回显、
  `match_presence_event` 的 joins / leaves、`GET /v2/match` 的五个筛选参数。

**不做**

- 运行时模块面（`nk.match_create` / `nk.match_join` 等）与真正的 tick 循环：
  M8 的范围。M7 用**声明式钩子**替代"运行时回调决定目标"这一半（ECN-0011 偏差 11）。
- 权威对局的 `tick_rate` / `handler_name`：随运行时一起在 M8 交付，M7 里恒为空。
- 派对（`/v2/party`）：M8 的范围（REQ-0001-019）。

## Acceptance

见 [v2-index.md](./v2-index.md) 的 M7 DoD（13 条）。

## Files

| 路径 | 作用 |
|---|---|
| `migrations/0005_match.sql` | `match_record` 表（列表端点的数据源） |
| `src/domain/match/{ids,presence,data,catalog,store,token}.ts` | match id 形状、成员表、中继路由纯函数、目录筛选、D1 存储、加入令牌 |
| `src/domain/matchmaker/{query,pool,process,stats,types,errors}.ts` | 查询解析与求值、票据池、成局算法、完成缓冲 |
| `src/durable/match{,-core,-members,-roster,-shapes,-call}.ts` | 每场对局一个 DO：创建 / 加入 / 离开 / 数据路由 / 目录同步 |
| `src/durable/matchmaker{,-core,-store,-call,-hook}.ts` | 每租户一个 DO：票据池、闹钟、成局投递、声明式钩子 |
| `src/durable/session-match.ts` | 会话分片侧的对局清单与 `MatchService` 实现 |
| `src/realtime/{match,matchmaker,pipeline-match,pipeline-matchmaker}.ts` | 帧形状、服务接口、四条 + 两条帧的管线 |
| `src/http/routes/match.ts` + `src/wire/match.ts` | 两条端点、校验顺序与逐字文案、protojson 线格式 |
| `tests/unit/match/`、`tests/unit/matchmaker/` | 纯函数与池子的搬运测试（7 个文件） |
| `tests/integration/match/`、`tests/integration/matchmaker/` | DO 边界上的语义（6 个文件） |
| `tests/e2e/match.e2e.test.ts` + `tests/e2e/match-helpers.ts` | 真实 WebSocket + 真实 HTTP 的全链路 |

## Steps

1. **红→绿**：match id 形状、成员表、中继路由纯函数、目录筛选（`tests/unit/match/`）。
2. **红→绿**：查询子集、票据池上限、成局算法（`tests/unit/matchmaker/`）。
3. **红→绿**：令牌签发与校验、`match_record` 的 D1 读写（`tests/unit/match/`）。
4. **红→绿**：四条对局帧的管线语义与文案（`tests/integration/match/pipeline.test.ts`）。
5. **红→绿**：成局目标（钩子）、每会话票数上限（`tests/integration/matchmaker/`）。
6. **红→绿**：注册表（创建 / 加入 / 查询 / 标签更新）与跨 DO 往返（`tests/integration/match/`）。
7. **绿**：两条 REST 端点的校验顺序与线格式。
8. **E2E**：两个客户端成局 → 用 token 各自 join → 中继互发 → 一方离开。
9. **覆盖矩阵与文档回填**：M7 段落 35 条全部 `planned → ported`，回填 ECN-0011。

## Risks

| 风险 | 缓解 |
|---|---|
| 成局帧的 `self` 与 `ticket` 是**逐人不同**的字段（上游在投递循环里逐个改），极易写成"一份帧发给所有人" | 用例断言两个收件人的 `self.presence.sessionId` 各是自己；另有一条红证据专门钉它（见下） |
| `token` 分支的 mid 是 `<uuid>.`（node 段为空）且**允许对局不存在**，与"给 match id"是两条不同的语义 | `pipeline.test.ts` 把两条分支分开断言（`allowEmpty` 为 true / false），E2E 从真实 token 出发走完整条链 |
| 中继数据的过滤语义（把别人写进 `presences` 才发给他、发送者默认不收自己的）容易抄成"广播给所有人" | `data.test.ts` 覆盖 5 条过滤形状；E2E 断言发送者**没收到**自己那一帧 |
| 查询串是 lucene 子集，`+`/`-`/boost/正则四件事的边界很容易抄反 | 上游 4 条用例（`AddButNotMatch*` / `RegexSubmatch*` / `MultipleAndSomeMatchWithBoost`）逐条搬运 |
| 列表端点的两套筛选（`label` 整串 vs `query` 子集）语义不同，且 `query` 优先 | `catalog.test.ts` + `registry.test.ts` 分别用"整串标签"和"数组属性"钉住 |
| DO 的 SQLite 与 D1 的秒/毫秒精度差 | 统一在 `catalog.ts` 内比较、在 `wire/match.ts` 转秒（ECN-0011 偏差 9） |
| 单文件 300 行上限 | `match-core.ts` 拆出 `match-roster.ts` / `match-shapes.ts`；E2E 拆出 `match-helpers.ts`；提交前逐个数行 |

## Evidence

每条 DoD 一条，命令与输出都可复现。全部在本机 workerd / 本地
`wrangler dev --local` 上跑，不连任何 Cloudflare 账号资源，因此不产生账单。

### 红/绿证据（反作弊条款：DoD 3 与 DoD 10）

三处红都做过，每处都是"把要验的那条机制摘掉，同一批用例立刻变红"，
恢复之后同一批用例全绿。红的那一版拦在同一个原因上：机制没了 = 断言没在自证。

```text
$ npx vitest run tests/unit/matchmaker            # 摘掉 hitsOf 里的查询命中筛选
 × matching.test.ts > test_a_one_sided_query_never_forms_a_match
   AssertionError: expected [ [ 'a', 'b' ] ] to deeply equal []
 Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 34 passed (35)
```

```text
$ npx vitest run tests/integration/matchmaker     # 让 self 恒等于组里第一个人
 × rounds.test.ts > test_an_authoritative_hook_turns_the_group_into_a_real_match_id
   AssertionError: expected '37f99e4e-…' to be 'e9afc642-…'   （self 不是收件人自己）
 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 13 passed (14)
```

```text
$ npx vitest run tests/integration/match/rest.test.ts   # 不注册 /v2/match 与 /v2/matchmaker/stats
 × 九条全部失败，断言里出现 501：expected 200 to be … / expected 501 to be 400
 Test Files  1 failed (1)
      Tests  9 failed (9)
```

```text
$ npx vitest run --config vitest.e2e.config.ts tests/e2e/match.e2e.test.ts   # 停掉匹配器闹钟
 × test_two_clients_match_join_by_token_exchange_data_then_one_leaves
   Error: 60000ms 内没等到目标帧。已收到：matchmakerTicket cid=add-alice
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
```

恢复实现之后，同一批用例全绿（数字见下表与 Review 记录）。

### 逐条 DoD

| DoD | 证据 | 命令与结果 |
|---:|---|---|
| 1 | 查询语言：`tests/unit/matchmaker/pool.test.ts` 前 8 条（`*`、可选/必须子句、禁止子句、数值区间只吃数值属性、boost 求和、未知字段恒不匹配、畸形查询在 `Add` 时被拒）+ `matching.test.ts` 的区间与正则用例 | `npm test` → **81 files / 574 tests 全绿** |
| 2 | `tests/unit/matchmaker/pool.test.ts`（`AddOnly` / `AddRemoveRepeated` / `RegexSubmatch` / `RegexSubmatchMultiple`）；用例头有 `溯源:` | 同上；覆盖矩阵对应 4 条 `ported` |
| 3 | `tests/unit/matchmaker/matching.test.ts`（基础匹配、`*`、增删、不匹配）+ `tests/integration/matchmaker/rounds.test.ts`（成局帧的 `ticket` / `token` / `self`） | 同上；红证据见上；覆盖矩阵对应 5 条 `ported` |
| 4 | `matching.test.ts` 的区间相容 4 条（2-4 不与 6-8 匹配） | 同上 |
| 5 | `matching.test.ts` 的多票 + boost 三条（只有一座位时长一对、boost 高者主导） | 同上 |
| 6 | `matching.test.ts` 的互配三条（单向满足不得成局） | 同上；红证据见上 |
| 7 | `tests/unit/matchmaker/tracking.test.ts`（每派对上限）+ `matching.test.ts` 的 `groupIndexes`（加权均值）+ `rounds.test.ts` 的每会话上限（被拒的票**不占位**：再放一张能成局） | 同上 |
| 8 | `tests/integration/matchmaker/rounds.test.ts`（钩子 → 权威 match id 且能直接 join；无钩子 → 30 秒 token） | 同上；红证据见上 |
| 9 | `tests/integration/match/{registry,roundtrip}.test.ts`（8 条注册表用例 + 3 条跨 DO 往返，逐字段相等）+ `tests/unit/match/{presence,data,ids,catalog}.test.ts` | 同上；覆盖矩阵 12 条 `ported` |
| 10 | `tests/integration/match/rest.test.ts`（七步校验顺序与逐字文案、空列表省 `matches` 键、`?label=` 与没给 label 的区别、`stats` 空池 `{}`）+ E2E 的 400 形状 | `npm test` + `npm run e2e` 均 0；红证据见上 |
| 11 | `tests/e2e/match.e2e.test.ts`（成局 → token join → 中继互发 → 离开事件） | `npm run e2e` → 见下表 |
| 12 | `npm run conformance:matrix` | M7 段落 `planned=0`、`unreasoned_exemptions=0`；第二证据源出现 `/v2/match` 与 `/v2/matchmaker/stats` |
| 13 | `npm run docs:check` + 人工核对 `docs/ecn/` | 退出码 0；ECN-0011 在 PRD、计划、覆盖矩阵三处可追 |

### 命令与数字

| 命令 | 结果 |
|---|---|
| `npm test` | **81 files / 574 tests 全绿**（M6 收尾是 65 files / 441 tests，M7 新增 16 个文件 133 条） |
| `npm run typecheck` | 退出码 0（`tsc --noEmit`） |
| `npm run e2e` | **9 files / 37 tests 全绿**（新增 `tests/e2e/match.e2e.test.ts`） |
| `npm run conformance:matrix` | `entries=263 ported=122 planned=140 exempt=1 unreasoned_exemptions=0 derived_citations=124`；**M7 桶 35 条目 / 35 ported / 0 planned / 0 exempt** |
| `npm run docs:check` | `docs_hygiene: files=32 requirements=26 plans=6 lines=4151 links=121 inventory_numbers=15 problems=0` |
