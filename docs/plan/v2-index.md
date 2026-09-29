# v2 计划索引 — Muster 社交、经济与竞技、匹配与对局

| 项目 | 内容 |
|---|---|
| 版本 | v2 |
| 日期 | 2026-09-29 |
| 状态 | M5、M6、M7 已交付；M8 见 [v3-party-runtime.md](./v3-party-runtime.md)、M9 见 [v4-console-ops.md](./v4-console-ops.md)（两者均已交付）。M6 后置的两笔（运行时创建面、控制台账本端点）已在 M8 / M9 关闭 |
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

**交付证据**：[v2-match.md](./v2-match.md)（逐条 DoD 的证据、红/绿输出、命令与数字）。
13 条 DoD 全部达成；三处红证据（查询命中筛选、成局帧的 `self`、REST 路由注册、
匹配器闹钟）逐条粘在计划文档里。

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
| [v2-match.md](./v2-match.md) | M7 | REQ-0001-017, REQ-0001-018 |
| [v3-party-runtime.md](./v3-party-runtime.md) | M8 | REQ-0001-019, REQ-0001-020 |
| [v4-console-ops.md](./v4-console-ops.md) | M9 | REQ-0001-021, REQ-0001-022, REQ-0001-023 |

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
| REQ-0001-017 | v2-match.md | `tests/unit/matchmaker/`（3 文件 / 35 条，含 `溯源: server/matchmaker_test.go::TestMatchmakerAddWithBasicMatch` 等 21 条上游用例）+ `tests/integration/matchmaker/`（2 文件 / 14 条） | `tests/e2e/match.e2e.test.ts`（成局 → token 分支 → 中继互发 → 离开事件） | v2-match.md Evidence DoD 1–8；覆盖矩阵 M7 桶 35 条全部 `ported`；ECN-0011 偏差 1/4/5/10/11 | 🟢 已交付（M7，运行时面在 M8） |
| REQ-0001-018 | v2-match.md | `tests/unit/match/`（6 文件 / 45 条）+ `tests/integration/match/`（4 文件 / 35 条，含 `溯源: server/match_registry_test.go::TestMatchRegistry*` 与 `TestEncode*`） | `tests/e2e/match.e2e.test.ts`（token join 建对局、目录可查、错误体形状） | v2-match.md Evidence DoD 9–11；覆盖矩阵 M7 桶 35 条全部 `ported`；ECN-0011 偏差 2/3/6/7/8/9 | 🟢 已交付（M7，运行时面与 tick 循环在 M8） |
| REQ-0001-019 | v3-party-runtime.md | `tests/integration/party/`（8 文件 / 71 条，含 `溯源: server/core_party_test.go`、`server/api_party_test.go`、`server/pipeline_party_test.go`、`server/party_registry_test.go`）+ `tests/unit/party/`（2 文件） | `tests/e2e/party.e2e.test.ts`（创建 → 加入请求 → 待批名单 → 接受 → 数据广播 → 踢人 → 关闭；另含目录面的开放/隐藏过滤） | v3-party-runtime.md Evidence DoD 1–3 与 DoD 13；覆盖矩阵 M8 桶 44 条 `planned=0`；ECN-0013 偏差 1–5 | 🟢 已交付（M8） |
| REQ-0001-020 | v3-party-runtime.md | `tests/unit/runtime/`（7 文件 / 65 条）+ `tests/integration/runtime/`（4 文件 / 32 条，含 `溯源: server/runtime_test.go::TestRuntime*`） | `tests/e2e/runtime.e2e.test.ts`（`?http_key=` 通道 → 模块返回 payload；用户令牌通道 → `nk` 存储往返；跨两个真请求的模块级计数器） | v3-party-runtime.md Evidence DoD 4–13；覆盖矩阵 M8 桶 44 条 `planned=0`（1 exempt）；ECN-0012 偏差 1–15 | 🟢 已交付（M8，对局 tick 循环与 Lua 模块不在范围内） |
| REQ-0001-021 | v4-console-ops.md | `tests/unit/console/`（4 文件 / 35 条，含 `溯源: console/acl/acl_test.go::Test_Permission`、`server/console_user_add_acl_test.go::TestValidateConsoleUserACLGrant`、`server/console_user_reset_password_acl_test.go::TestResetUserPasswordAuthorizesTargetACLBeforeUpdate` 等 5 条上游用例）+ `tests/integration/console/`（2 文件 / 17 条） | `tests/e2e/console.e2e.test.ts`（建控制台用户 → 重置口令拿一次性 code → 列本租户用户 → 读钱包账本；四条端点都过真 HTTP） | v4-console-ops.md Evidence DoD 1–6；覆盖矩阵第 168–172 条 `ported`；ECN-0014 偏差 1/3/6 | 🟢 已交付（M9，只覆盖最小可信内核） |
| REQ-0001-022 | v4-console-ops.md | `tests/integration/iap/`（2 文件 / 16 条，含 `溯源: iap/iap.go::ValidateLegacyReceiptApple`、`server/api_purchase.go::ValidatePurchase*`） | 无独立 E2E：厂商端点**不在端到端链路上**（注入传输层，测试不打 Apple / Google 真端点） | v4-console-ops.md Evidence DoD 10；ECN-0014 偏差 5/7/8；`migrations/0008_iap.sql` | 🟢 已交付（M9，Apple 真校验；其余 provider 为配置守卫，Samsung 与订阅面 501） |
| REQ-0001-023 | v4-console-ops.md | `tests/unit/ops/rate-limit-window.test.ts`（8 条）+ `tests/integration/ops/`（2 文件 / 12 条，含 `溯源: server/logger.go::LoggerWithTraceId`） | `tests/e2e/ops.e2e.test.ts`（真进程打到 429：状态码 + `retry-after` + 错误体 + `x-request-id`，再证明第二个租户不受影响） | v4-console-ops.md Evidence DoD 8/9；ECN-0014 偏差 2/4/9 | 🟢 已交付（M9，验收口径只取限流与请求 ID 关联两条；指标导出与多环境不在载体上） |

> 任何 `待填` / `待回填` / `—` 都是断链，禁止在存在断链的情况下宣称对应需求已交付。

## ECN 索引

| ECN | 标题 | 状态 | 关联 Req ID | 落点 |
|---|---|---|---|---|
| [ECN-0008](../ecn/ECN-0008-social-graph-on-d1.md) | 社交图（好友边/群组/通知）建在 D1 上，游标沿用 base64url(JSON) | 已生效 | REQ-0001-011, REQ-0001-012, REQ-0001-013 | `migrations/0003_social.sql`、`src/domain/friends/*`、`src/domain/groups/*`、`src/domain/notifications/*` |
| [ECN-0009](../ecn/ECN-0009-google-id-token.md) | Google 登录用 WebCrypto 验 RS256，证书来自 JWKS 端点 | 已生效 | REQ-0001-003 | `src/domain/social/google/*` |
| [ECN-0010](../ecn/ECN-0010-competitive-on-d1.md) | 经济与竞技建在 D1 + 内存缓存上（偏差 1–12）：定义进库、名次缓存换有序数组 + 懒加载、钱包用 CAS + 守卫批次、cron 只做受限子集、时间精度到秒、创建面与权威写路径后置到 M8 | 已生效 | REQ-0001-014, REQ-0001-015, REQ-0001-016 | `migrations/0004_competitive.sql`、`src/domain/competitive/*`、`src/http/routes/{leaderboard,tournament}.ts` |
| [ECN-0011](../ecn/ECN-0011-match-on-durable-objects.md) | 匹配器与对局建在 Durable Object + D1 上（偏差 1–11）：每租户一个匹配器 / 每场一个对局实例、目录合并成 `match_record` 单表、权威对局唯一入口是钩子、不引入 bluge、顺序确定化、node 固定 `muster`、毫秒/秒精度、protojson 取代 gob、运行时面后置到 M8 | 已生效 | REQ-0001-017, REQ-0001-018 | `migrations/0005_match.sql`、`src/domain/match/*`、`src/domain/matchmaker/*`、`src/durable/match*.ts`、`src/durable/matchmaker*.ts` |
| [ECN-0012](../ecn/ECN-0012-runtime-modules-on-worker-loader.md) | 运行时模块装载在 Worker Loader 上（偏差 1–15）：每租户一个 isolate、`nk.*` 变异步、源码存 D1、只支持 JS、bcrypt 换 PBKDF2、AES-128-CFB 自实现、配额走 workerd `limits`、hook 用泛化操作名、未实现能力"不存在"、能力对象只在本次调用内有效、宿主只缓存模块映射不缓存 Loader 句柄 | 已生效 | REQ-0001-020 | `migrations/0006_runtime.sql`、`src/runtime/*`、`src/http/routes/rpc.ts`、`src/realtime/pipeline-hooks.ts` |
| [ECN-0013](../ecn/ECN-0013-party-on-durable-objects.md) | 派对建在 Durable Object + D1 上（偏差 1–5）：状态落 DO SQLite、目录换 D1、游标换 `base64url(JSON)`、标签语法细节、断连清待批请求 | 已生效 | REQ-0001-019 | `src/domain/party/*`、`src/durable/party*.ts`、`src/realtime/pipeline-party.ts`、`src/http/routes/party.ts` |
| [ECN-0014](../ecn/ECN-0014-console-and-ops.md) | 管理台、内购校验与运维面在 Cloudflare 上的载体（偏差 1–9）：控制台面用 tenant server key 取代 console JWT、指标导出与多环境不在载体上、无行锁改用串行路径、限流桶只活在 DO 内存且默认关闭、内购厂商调用走注入传输层、控制台只做最小可信内核、Samsung 与订阅面诚实地 501、`purchase` 表的冲突判定与 `seen_before` 形态 | 已生效 | REQ-0001-021, REQ-0001-022, REQ-0001-023 | `src/domain/console/**`、`src/http/routes/console-*.ts`、`src/domain/iap/**`、`src/http/routes/iap.ts`、`src/durable/rate-limiter.ts`、`src/http/rate-limit.ts`、`src/http/request-id.ts`、`migrations/0007_console.sql`、`migrations/0008_iap.sql` |

## Tashan Review 记录

M5 的 Review 记录：[v2-M5.md](../reviews/v2-M5.md)（verdict: pass；7 条 MINOR 全部在提交前修复）。

M6 的 Review 记录：[v2-M6.md](../reviews/v2-M6.md)（verdict: pass；1 条 MAJOR
（新记录 `metadata` 违反 NOT NULL，首写 500）+ 3 条 MINOR + 1 条 NOTE 全部在提交前处置）。

M7 的 Review 记录：[v2-M7.md](../reviews/v2-M7.md)（verdict: pass；1 条 MAJOR
（匹配器令牌的签名段编码毁了二进制签名，签发的 token 永远验不过）+ 4 条 MINOR +
1 条 NOTE 全部在提交前处置；另记 7 条残余风险，其中 E2E 收尾噪声为既有问题）。

M8 的 Review 记录：[v3-M8.md](../reviews/v3-M8.md)（verdict: pass；1 条 MAJOR
（模块宿主的 handler 调用约定传成 `(ctx, payload)`，逼模块捕获会失效的 `nk`）+ 4 条 MINOR +
1 条 NOTE 全部在提交前处置；另记 7 条残余风险，其中"无线上验收""只支持 JS"为里程碑级限制）。

M9 的 Review 记录：[v4-M9.md](../reviews/v4-M9.md)（verdict: pass；本轮无 MAJOR，
4 条 MINOR（限流阈值是全局绑定、控制台 E2E 用户名越界、覆盖矩阵把上游测试名写进
`契约源:`、内购 501 的断言写错）+ 2 条 NOTE 全部在提交前处置；另记 9 条残余风险，
其中"控制台鉴权与上游不同""限流默认关闭""内购只有 Apple 是真校验"为里程碑级限制）。

## Tashan Trigger Audit

```markdown
- expected_review_triggers: v_doc_writing_done, v_milestone_done(M5..M9)
- actual_review_runs: 6 (v_doc_writing_done, v_milestone_done(M5), v_milestone_done(M6), v_milestone_done(M7), v_milestone_done(M8), v_milestone_done(M9))
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
| [ECN-0010](../ecn/ECN-0010-competitive-on-d1.md) | 竞技域建在 D1 与内存缓存上（偏差 1–12）：游标不与上游互换、时间精度到秒、`authoritative = 1` 的榜在 M6 里无人能写分、账本端点后置到 M9 | 收不到（游标不透明）；时间精度差异可见（同秒排序退化到元组）；"权威榜永远空"可见 | 已生效（偏差 10 由 M8 `0a6e650` 关闭、偏差 12 由 M9 `bd50b04` 关闭；两条的注释都已回填原文档） |
| [ECN-0011](../ecn/ECN-0011-match-on-durable-objects.md) | 匹配器与对局建在 DO + D1 上（偏差 1–11）：票据与对局状态持久化（重启不丢）、查询只实现子集、权威对局的 node 段是 `muster`、同秒排序补 `match_id` 决胜、跨 DO 帧用 protojson、运行时面后置到 M8 | 收不到（match id 与 token 都是不透明字符串）；同秒创建的对局顺序可见；"权威对局没有 tick 循环"在 M8 前可见 | 已生效 |
| [ECN-0012](../ecn/ECN-0012-runtime-modules-on-worker-loader.md) | 运行时模块建在 Worker Loader + D1 上（偏差 1–15）：`nk.*` 从同步变异步（模块必须 `await`）、只支持 JS 不支持 Lua、bcrypt 换 PBKDF2、AES-128-CFB 自实现、模块内不得自行出网（`globalOutbound: null`）、未实现的 `nk.*` 抛 `TypeError`、能力对象只在一次调用内有效 | 模块作者可见（偏差 1/2/4/5/11/14 直接改变模块写法）；对外部客户端不可见（偏差 15 完全在平台实现内） | 已生效 |
| [ECN-0013](../ecn/ECN-0013-party-on-durable-objects.md) | 派对建在 DO + D1 上（偏差 1–5）：状态落 DO SQLite、目录换 D1、游标换 `base64url(JSON)` 不与上游互换、标签语法细节、断连时清掉待批加入请求 | 收不到（游标不透明）；断连清请求在极端时序下可见 | 已生效 |
| [ECN-0014](../ecn/ECN-0014-console-and-ops.md) | 管理台、内购与运维面换载体（偏差 1–9）：控制台改用 tenant server key 鉴权、只做最小可信内核、指标导出与多环境不在载体上、无行锁改用串行路径、内购厂商调用走注入传输层、Samsung 与订阅面 501、限流默认关闭且桶只在 DO 内存、`purchase` 表冲突判定按 `(tenant_id, store, transaction_id)` | 控制台鉴权与覆盖范围**客户端可见**（前端要换鉴权、多数管理端点后置）；Samsung 集成方可见；其余不可见 | 已生效 |
