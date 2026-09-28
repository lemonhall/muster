# v2 计划索引 — Muster 社交、经济与竞技、匹配与对局

| 项目 | 内容 |
|---|---|
| 版本 | v2 |
| 日期 | 2026-09-29 |
| 状态 | 进行中（M5、M6 已交付；M7 范围已定，DoD 在启动时冻结） |
| 成本档位 | `standard`（普通功能交付，最多 3 轮 Review） |
| 愿景 | [../prd/VISION.md](../prd/VISION.md) |
| 需求基线 | [PRD-0001](../prd/PRD-0001-muster-parity.md) |
| 上一版 | [v1-index.md](./v1-index.md) |

## 本轮目标

v1 证明了"这套后端能在 Cloudflare 上跑通"（身份、存储、实时、频道）。
v2 证明的是**它不只有骨架**：社交关系（好友/群组/通知）、经济与竞技
（钱包/排行榜/锦标赛）、匹配与对局，这三块是"能开一个真游戏"与"只有一个 demo"
之间的分水岭。每一块都仍然按上游测试套件与 proto/swagger 推导的契约测试对齐。

## 里程碑

### M5 社交（好友/群组/通知/社交登录令牌校验）

**范围**：好友关系（请求/接受/删除/拉黑/好友的好友）、群组（创建/更新/删除/加入/
离开/踢人/封禁/升降职/列表）、通知（列表/删除，以及由社交事件产生的通知）、
Google ID token 校验（aud/azp 规则与授权码流程）。同时关闭 v1 留下的两处后置：
私聊请求通知（ECN-0007 偏差 2）与群组频道准入（`canAccessGroup`）。

**DoD（逐条可判定 + 验证命令 + 反作弊）**

| # | DoD | 验证命令 | 预期 |
|---|---|---|---|
| 1 | `TestServer_ListFriendsOfFriends` 的 4 个子用例全部搬运：空好友表回空列表、排除共同好友并给出 referrer、`limit=1` 时给出游标、带游标取到下一页（`limit=2` + 游标 → 1 条） | `npm test` | 退出码 0，4 条用例名出现在输出里 |
| 2 | 好友状态机：加好友写出双向边（`INVITE_SENT` / `INVITE_RECEIVED`）并给对方产生 `-2` 通知；对方回加 → 双向 `FRIEND` 并产生 `-3` 通知；删除 → 双向边消失并产生 `-9` 通知；拉黑 → 自己的边变 `BLOCKED`、反向边删除，且被拉黑者无法再加 | `npm test` | 断言全绿（含通知落库断言） |
| 3 | Google ID token：`TestCheckGoogleTokenValidatesAudience` 的 8 个子用例 + 3 个独立用例（OAuth client ID、未配置 client ID 放行、数组 aud 被拒）、`TestCheckGoogleTokenPreservesAuthorizationCodeFlow`、`TestCheckGoogleTokenDoesNotExchangeMalformedJWT` 全部搬运；每条都用**本机生成的 RSA 密钥**签名，不访问任何远端 | `npm test` | 断言全绿；"畸形 JWT 不触发外部请求"用外部请求计数 = 0 判定 |
| 4 | 群组：创建（重名 → 409 `Group name is in use.`，创建者是 SUPERADMIN 且 `edge_count=1`）、开放群组直接加入、私有群组生成 join request 并给管理员发 `-5` 通知、`max_count` 上限生效 → `Group is full.` | `npm test` | 断言全绿 |
| 5 | 群组权限矩阵：只有 SUPERADMIN/ADMIN 能 add/kick/ban/promote/demote；普通成员与环境外用户一律被拒（`Group not found or permission denied.`）；最后一个 superadmin 不能离开（`Cannot leave group when you are the last superadmin.`） | `npm test` | 断言全绿（矩阵逐格覆盖） |
| 6 | 通知：列表默认 `limit=1`、按 `create_time, id` 升序、`cacheable_cursor` 恒在（空列表也给）、带游标翻页不重不漏；删除按 id 且跨用户删不掉 | `npm test` | 断言全绿 |
| 7 | 私聊请求通知（关闭 ECN-0007 偏差 2）：新加入 DM 且对方不在频道时，给对方产生 `-1` 通知（`<username> wants to chat`）；对方已在频道时不产生 | `npm test` | 断言全绿 |
| 8 | 群组频道准入（关闭 ECN-0007 偏差 4）：成员能进 `3.<group_id>` 频道并收发消息，非成员被拒 | `npm test` | 断言全绿 |
| 9 | E2E：真实 HTTP 面走完"注册两个账号 → 加好友 → 对方读通知 → 接受 → 双方互相出现在好友列表 → 建群 → 第二人加入 → 群列表 → 通知删除" | `npm run e2e` | 退出码 0 |
| 10 | 覆盖矩阵中 M5 的 4 条 `planned` 全部转 `ported`；群组与通知的对外可观测行为由第二证据源（swagger 路径 + proto 字段推导的契约测试）承担 | `npm run conformance:matrix` | M5 段落无 `planned` 残留，且第二证据源段出现 `/v2/group` 与 `/v2/notification` |
| 11 | 与上游的刻意偏差有 ECN 且从 PRD / 计划 / 覆盖矩阵三处可追 | `npm run docs:check` + 人工核对 `docs/ecn/` | 退出码 0；ECN-0008、ECN-0009 在 PRD 与计划里都有引用 |

**反作弊条款**

- 第 1 条与第 3 条的用例必须先红后绿，红/绿输出粘贴到 [v2-social.md](./v2-social.md) 的 Evidence 段。
- 第 3 条**不得**用打桩替换掉 JWT 验签：测试里生成的 RSA 私钥签名必须由被测代码用公钥验过，
  否则"aud 校验"只是在一个没验签的分支上跑。
- 第 5 条的权限矩阵必须逐格断言（每个角色 × 每个操作），不允许只测"能"或只测"不能"。
- 通知与好友关系的断言必须读**库里的行**，不允许只看 HTTP 响应体。

### M6 经济与竞技（钱包/排行榜/锦标赛）

**范围**：REQ-0001-014（钱包与账本）、REQ-0001-015（排行榜：best/incr/set、衰减、
重置周期、owner 记录）、REQ-0001-016（锦标赛：起止、规模、尝试次数、加入与排名）。

**DoD（逐条可判定 + 验证命令 + 反作弊）**

| # | DoD | 验证命令 | 预期 |
|---|---|---|---|
| 1 | `TestApiLeaderboard` 的 5 个子用例全部搬运：空榜回空列表、SET 覆盖之后顺序重排（500 → 200 → 排到第一）、删分之后人从列表消失、haystack 的中间 / 榜首 / 榜尾三个位置、关掉名次之后 `rank` 全为 0 而顺序不变 | `npm test` | 退出码 0；覆盖矩阵第 64 条 `ported` |
| 2 | 四种 operator（BEST / SET / INCREMENT / DECREMENT）与请求级 `operator` 覆盖：`BEST` 是"更好才更新"、`SET` 直接覆盖、`INCREMENT` 累加、`DECREMENT` 扣减且**首次插入写 0 而不是负数**；两套 operator 编号（榜单 0..3 与 `api.Operator` 0..4）不混用 | `npm test` | 断言全绿 |
| 3 | 重置周期：`calculateTournamentDeadlines` 的 4 条上游用例逐条搬运（每工作日 / 每 14 天 / 现在早于开赛 / 现在正好落在重置点），另有 `computeNext` 的下一跳与"结束的锦标赛不再露出当期数据" | `npm test` | 断言全绿；覆盖矩阵第 66–69、87–88 条 `ported` |
| 4 | 名次缓存：上游 9 条逐条搬运（升序 / 降序插入、重复插入的世代号语义、`Fill` 返回"这一期总条目数"、删除与删榜、过期分桶与排行榜隔离、`TrimExpired`） | `npm test` | 断言全绿；覆盖矩阵第 77–85 条 `ported` |
| 5 | `TestApiTournamentHaystack` 搬运：best + desc、五人 10/20/30/40/50、owner 是 30 分、`limit=3` → 记录是 40/30/20（名次 2/3/4），`prev_cursor` 翻出 50（名次 1）、`next_cursor` 翻出 10（名次 5），**两个游标不相等** | `npm test` | 断言全绿；覆盖矩阵第 65 条 `ported` |
| 6 | 锦标赛约束：目录的四条边界文案（`categoryEnd >= 128` / `categoryEnd < categoryStart` / `endTime < startTime` / `limit` 越界）、默认只列未结束的、`join_required` 未报名写分被拒（`Must join tournament before attempting to write value.`）、报名后可写、重复报名幂等、`max_size` 满员被拒且不占位、权威榜 403、不存在的锦标赛三条 404 | `npm test` | 断言全绿；第二证据源段出现 `/v2/tournament` 与 `/v2/leaderboard/{leaderboardId}` |
| 7 | 钱包：上游 `core_wallet_test.go` 的 7 条逐条搬运（终值 984 与 0），加上并发写、CAS 守卫整批回滚、`updateLedger=true` 写账本行；账本存储层另有倒序取页、反向游标、时间窗过滤与 `json_patch` 合并 | `npm test` | 断言全绿；覆盖矩阵第 70–76 条 `ported` |
| 8 | E2E：真实 HTTP 面上三条路由的 404 形状、请求体与 `limit` 的校验顺序、目录参数与空目录、无令牌 401 | `npm run e2e` | 退出码 0 |
| 9 | 与上游的 12 条刻意偏差都有 ECN 且从 PRD / 计划 / 源码注释三处可追 | `npm run docs:check` + 人工核对 | 退出码 0；[ECN-0010](../ecn/ECN-0010-competitive-on-d1.md) 在 PRD、计划、覆盖矩阵三处都有引用 |
| 10 | 覆盖矩阵中 M6 的 `planned` 清零：两条 API 用例转 `ported`，上游自己 `t.Skip` 的 `TestLeaderboardScheduler` 在 `docs/conformance/exemptions.json` 里有非空理由的豁免 | `npm run conformance:matrix` | M6 段落 `planned=0`；`unreasoned_exemptions=0` |

**反作弊条款**

- 第 1 条与第 5 条的用例必须先红后绿，红/绿输出粘贴到
  [v2-competitive.md](./v2-competitive.md) 的 Evidence 段。
- 第 4 条的世代号语义必须用"同一 owner 用更小的世代号再插一次"来钉，不能只看"插进去有名次"。
- 第 6 条的每一条拒绝路径都断言**状态码 + 文案**两件事；只断状态码无法区分"拒绝"与"拒绝错了理由"。
- 第 7 条的"整数不动"必须读**库里的钱包列**，不允许只看返回值。
- 第 8 条的 E2E 不得只断言 200：必须断言错误体是上游 `google.rpc.Status` 的形状（`{code, message}`）。

### M7 匹配与对局

**范围**：REQ-0001-017（匹配器：ticket、查询表达式、数值属性、min/max/count_multiple、
超时）、REQ-0001-018（对局：authoritative match 生命周期、RPC hook、状态落盘、
广播过滤、可查询的对局列表）。DoD 在 M7 启动时写入本节并冻结。

**DoD（逐条可判定 + 验证命令 + 反作弊）**

| # | DoD | 验证命令 | 预期 |
|---|---|---|---|
| 1 | 匹配器查询语言：`*`、`field:value`、`+`/`-` 前缀、`>=`/`<=`/`>`/`<` 数值范围、`/regex/`、`^boost` 全部可解析；`properties.` 之外的字段按"索引里不存在"处理（恒不匹配但保留布尔结构）；畸形查询在 `Add` 时被拒 | `npm test` | 退出码 0，查询子集用例全绿 |
| 2 | `TestMatchmakerAddOnly`、`TestMatchmakerAddRemoveRepeated`、`TestMatchmakerPropertyRegexSubmatch`、`TestMatchmakerPropertyRegexSubmatchMultiple` 搬运 | `npm test` | 断言全绿；覆盖矩阵对应 4 条 `ported` |
| 3 | 基础匹配：`AddWithBasicMatch`（双方互配后各收到 `matchmaker_matched`，带 ticket 与 token，`self` 是收件人自己）、`AddWithMatchOnStar`、`AddAndRemove`、`AddRemoveNotMatch`、`AddButNotMatch` | `npm test` | 断言全绿；覆盖矩阵对应 5 条 `ported` |
| 4 | 数值范围与 min/max 兼容：`AddWithMatchOnRange`、`AddWithMatchOnRangeAndValue`、`AddButNotMatchOnRange`、`AddButNotMatchOnRangeAndValue` —— 两端 min/max 必须互相兼容（2-4 不与 6-8 匹配） | `npm test` | 断言全绿 |
| 5 | 多票与 boost：`AddMultipleAndSomeMatch`、`AddMultipleAndSomeMatchWithBoost`、`AddMultipleAndSomeMatchOptionalTextAlteringScore` —— 只有一座位时只成一对，boost 高的子句主导顺序 | `npm test` | 断言全绿 |
| 6 | 互配（mutual match）：`RequireMutualMatch`、`RequireMutualMatchLarger`、`RequireMutualMatchLargerReversed` —— 单向满足不得成局；`rev_precision` 打开时按双向判定 | `npm test` | 断言全绿 |
| 7 | 派对与上限：`GroupIndexes` 的递归分组（含 avgCreatedAt 的加权均值）、`MaxPartyTracking`、`MaxSessionTracking`（每会话/每派对最多 3 张票，超出报错且不占位） | `npm test` | 断言全绿 |
| 8 | 权威对局成局：`AddAndMatchAuthoritative` —— 成局回调返回 match id 时 `matchmaker_matched.id` 是 match id（不是 token），且该 id 能直接 `match_join` | `npm test` | 断言全绿 |
| 9 | 对局注册表：`match_registry_test.go` 的 8 条用例搬运（`Encode`/`EncodeDecode`/`EncodeDecodePresences` 三条 gob 用例等价物是"跨 DO 边界往返后条目字段不变"）+ `TestMatchPresenceList` | `npm test` | 断言全绿；覆盖矩阵对应 12 条 `ported` |
| 10 | REST：`GET /v2/match`（`limit` 1..100、`authoritative`/`label`/`min_size`/`max_size`/`query` 五个参数各自独立校验）、`GET /v2/matchmaker/stats`（空池 → `ticket_count=0`） | `npm test` + `npm run e2e` | 退出码 0；错误体是 `{code, message}` 形状 |
| 11 | E2E：真实 WebSocket 链路上"两个客户端 `matchmaker_add` → 双方收到 `matchmaker_matched` → 各自 `match_join` → 互发 `match_data` → 一方 `match_leave` → 另一方收到 `match_presence_event`" | `npm run e2e` | 退出码 0 |
| 12 | 覆盖矩阵中 M7 的 35 条 `planned` 清零：本条目的 `ported` 或带非空理由的豁免；第二证据源出现 `/v2/match` 与 `/v2/matchmaker/stats` | `npm run conformance:matrix` | M7 段落 `planned=0`；`unreasoned_exemptions=0` |
| 13 | 与上游的刻意偏差有 ECN 且从 PRD / 计划 / 源码注释三处可追 | `npm run docs:check` | 退出码 0；[ECN-0011](../ecn/ECN-0011-match-on-durable-objects.md) 在 PRD、计划、覆盖矩阵三处都有引用 |

**反作弊条款**

- 第 3 条与第 10 条的用例必须先红后绿，红/绿输出粘贴到 [v2-match.md](./v2-match.md) 的 Evidence 段。
- 第 3 条的断言必须读**到达会话的那一帧**（收件人自己的 `self`、`users` 长度、ticket），
  不允许只看"成局函数返回了非空"。
- 第 6 条必须构造"单向满足"的真实票面：A 的查询匹配 B 的属性、B 的查询不匹配 A 的属性，
  断言**没有**任何一方收到成局帧；只用"少放一张票"不算。
- 第 7 条的上限必须断言"被拒的那张票没有留在池子里"（再放一张能成局，证明没占位）。
- 第 9 条的往返用例必须断言字段级相等（presence 的 user/session/username、properties、
  party_id），不允许只断言"能解析成对象"。

## 计划索引

| 计划 | 覆盖里程碑 | Req ID |
|---|---|---|
| [v2-social.md](./v2-social.md) | M5 | REQ-0001-011, REQ-0001-012, REQ-0001-013，以及 REQ-0001-003 的 OAuth 分支 |
| [v2-competitive.md](./v2-competitive.md) | M6 | REQ-0001-014, REQ-0001-015, REQ-0001-016 |

## 追溯矩阵

| Req ID | v2 计划 | 单元/集成测试 | E2E | 证据 | 状态 |
|---|---|---|---|---|---|
| REQ-0001-011 | v2-social.md | `tests/integration/friends/`（4 文件 / 28 条，含 `溯源: server/core_friend_test.go::TestServer_ListFriendsOfFriends`） | `tests/e2e/social.e2e.test.ts`（好友请求→通知→接受→互列好友） | v2-social.md Evidence DoD 1/2；覆盖矩阵第 60 条 `ported` | 🟢 已交付（M5） |
| REQ-0001-012 | v2-social.md | `tests/integration/groups/`（6 文件 / 34 条）+ `tests/integration/channel/{group-access,dm-request}.test.ts` | `tests/e2e/social.e2e.test.ts`（建群→加入→两条群列表→群目录） | v2-social.md Evidence DoD 4/5/7/8；ECN-0008 偏差 7–14 | 🟢 已交付（M5） |
| REQ-0001-013 | v2-social.md | `tests/integration/notifications/`（2 文件 / 6 条） | `tests/e2e/social.e2e.test.ts`（读收件箱、删自己的通知、别人删不掉） | v2-social.md Evidence DoD 6；第二证据源 `swagger.json::/v2/notification` | 🟢 已交付（M5） |
| REQ-0001-003（OAuth 分支） | v2-social.md | `tests/integration/social/`（5 文件 / 28 条，本机 RSA 私钥签名） | 不适用（Google 验签不在端到端链路上） | v2-social.md Evidence DoD 3；覆盖矩阵第 61/62/63 条 `ported`；ECN-0009 | 🟢 已交付（M5，其余 provider 仍为配置守卫） |
| REQ-0001-014 | v2-competitive.md | `tests/integration/competitive/wallet.test.ts`（11 条）+ `wallet-ledger.test.ts`（4 条） | 无独立 E2E（钱包没有 REST 面；运行时面在 M8） | v2-competitive.md Evidence DoD 7；覆盖矩阵第 70–76 条 `ported`；ECN-0010 偏差 6/7/12 | 🟢 已交付（M6，账本端点后置到 M9） |
| REQ-0001-015 | v2-competitive.md | `tests/integration/competitive/{leaderboard,leaderboard-haystack}.test.ts`（7 条）+ `tests/unit/competitive/`（16 条） | `tests/e2e/competitive.e2e.test.ts`（路由注册、404 形状、校验顺序） | v2-competitive.md Evidence DoD 1/2/4；覆盖矩阵第 64、66–69、77–88 条 `ported` | 🟢 已交付（M6，创建面在 M8） |
| REQ-0001-016 | v2-competitive.md | `tests/integration/competitive/{tournament,tournament-endpoints}.test.ts`（7 条） | `tests/e2e/competitive.e2e.test.ts`（目录参数、空目录、404） | v2-competitive.md Evidence DoD 5/6；覆盖矩阵第 65 条 `ported`；ECN-0010 偏差 4/9/11 | 🟢 已交付（M6，创建面在 M8） |

> 任何 `待填` / `待回填` / `—` 都是断链，禁止在存在断链的情况下宣称对应需求已交付。

## ECN 索引

| ECN | 标题 | 状态 | 关联 Req ID | 落点 |
|---|---|---|---|---|
| [ECN-0008](../ecn/ECN-0008-social-graph-on-d1.md) | 社交图（好友边/群组/通知）建在 D1 上，游标沿用 base64url(JSON) | 已生效 | REQ-0001-011, REQ-0001-012, REQ-0001-013 | `migrations/0003_social.sql`、`src/domain/friends/*`、`src/domain/groups/*`、`src/domain/notifications/*` |
| [ECN-0009](../ecn/ECN-0009-google-id-token.md) | Google 登录用 WebCrypto 验 RS256，证书来自 JWKS 端点 | 已生效 | REQ-0001-003 | `src/domain/social/google/*` |
| [ECN-0010](../ecn/ECN-0010-competitive-on-d1.md) | 经济与竞技建在 D1 + 内存缓存上（偏差 1–12）：定义进库、名次缓存换有序数组 + 懒加载、钱包用 CAS + 守卫批次、cron 只做受限子集、时间精度到秒、创建面与权威写路径后置到 M8 | 已生效 | REQ-0001-014, REQ-0001-015, REQ-0001-016 | `migrations/0004_competitive.sql`、`src/domain/competitive/*`、`src/http/routes/{leaderboard,tournament}.ts` |

## Tashan Review 记录

M5 的 Review 记录：[v2-M5.md](../reviews/v2-M5.md)（verdict: pass；7 条 MINOR 全部在提交前修复）。

M6 的 Review 记录：[v2-M6.md](../reviews/v2-M6.md)（verdict: pass；1 条 MAJOR
（新记录 `metadata` 违反 NOT NULL，首写 500）+ 3 条 MINOR + 1 条 NOTE 全部在提交前处置）。

## Tashan Trigger Audit

```markdown
- expected_review_triggers: v_doc_writing_done, v_milestone_done(M5..M7)
- actual_review_runs: 3 (v_doc_writing_done, v_milestone_done(M5), v_milestone_done(M6))
- skipped_triggers: 0
- skip_reasons: 独立子代理派发不通（本机限制），降级为同模型自评 + 命令证据
- mitigation: 每个里程碑完成前必须补 Review 记录，否则不输出完成信号
```

## 差异列表（v2 结束时回填）

v2 与上游的**全部**刻意差异都登记在 ECN 里，这里只做索引与"客户端看不看得见"的分类。

| ECN | 差异 | 客户端可见？ | 处置 |
|---|---|---|---|
| [ECN-0008](../ecn/ECN-0008-social-graph-on-d1.md) | 社交图与通知建在 D1 上（偏差 1–14）；游标不透明但不与上游互换；时间精度到秒；群成员变更与群频道系统消息不是同一事务；多目标满员时逐目标原子 | 收不到（游标不透明）；时间精度差异可见（同秒多条时排序按 id）；"批内部分成功"在满员时可观察 | 已生效 |
| [ECN-0009](../ecn/ECN-0009-google-id-token.md) | Google 证书从 JWKS（`/oauth2/v3/certs`）取而不是 X.509 PEM 端点 | 不可见 | 已生效 |
| [ECN-0010](../ecn/ECN-0010-competitive-on-d1.md) | 竞技域建在 D1 与内存缓存上（偏差 1–12）：游标不与上游互换、时间精度到秒、`authoritative = 1` 的榜在 M6 里无人能写分、账本端点后置到 M9 | 收不到（游标不透明）；时间精度差异可见（同秒排序退化到元组）；"权威榜永远空"可见 | 已生效 |
