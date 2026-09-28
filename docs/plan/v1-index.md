# v1 计划索引 — Muster 地基、身份、存储、实时骨架

| 项目 | 内容 |
|---|---|
| 版本 | v1 |
| 日期 | 2026-09-28 |
| 状态 | 计划完成，执行中 |
| 成本档位 | `standard`（普通功能交付，最多 3 轮 Review） |
| 愿景 | [../prd/VISION.md](../prd/VISION.md) |
| 需求基线 | [PRD-0001](../prd/PRD-0001-muster-parity.md) |

## 本轮目标

把"能用 Cloudflare 重实现这套游戏后端"从判断变成**可运行、可测试、可追溯的证据**：先立地基与一致性工装（M0），再打通一条从客户端认证到存储读写、再到 WebSocket 会话与聊天的端到端纵切（M1–M4）。v1 不追求功能全覆盖，追求**第一个里程碑链条的证据完整**。

## 里程碑

### M0 工程地基与一致性工装

**范围**：仓库骨架、wrangler/workerd 本地运行时、TypeScript 工程链、无 Docker 的测试与 E2E 通道、上游测试清单脚本、覆盖矩阵脚本、文档卫生脚本。

**DoD（逐条可判定 + 验证命令 + 反作弊）**

| # | DoD | 验证命令 | 预期 |
|---|---|---|---|
| 1 | 契约测试 ≥3 条通过：`GET /` → 200；`GET /healthcheck` → 200 且 body 精确等于 `{}`；未知路径 → 404 且为 JSON 错误体 | `npm test` | 退出码 0，输出含 3 条契约用例名 |
| 2 | 类型检查无错误 | `npm run typecheck` | 退出码 0 |
| 3 | E2E 独立通道：真实启动本地 Worker 进程，经 HTTP 访问（不是直接 import 处理器函数） | `npm run e2e` | 退出码 0，日志含实际监听地址 |
| 4 | 上游测试清单脚本可生成 263 条目的清单，并记录上游 commit SHA | `npm run conformance:inventory` | 生成 `docs/conformance/upstream-inventory.md`，条目数 = 263 |
| 5 | 覆盖矩阵脚本：每条上游测试必须出现在矩阵中，状态 ∈ {ported, planned, exempt(带理由)}，无理由豁免数为 0 | `npm run conformance:matrix` | 退出码 0，输出 `unreasoned_exemptions=0` |
| 6 | 文档卫生检查：需求编号连续、计划含 PRD Trace、无模糊词、内部链接无断链 | `python scripts/doc_hygiene_check.py --root .` | 退出码 0 |

**反作弊条款**

- 三条契约测试必须**至少红过一次**，红/绿输出粘贴到 [v1-foundation.md](./v1-foundation.md) 的 Evidence 段；不允许"写完实现再补测试"。
- `npm test` 必须运行在 workerd 运行时（vitest-pool-workers 配置生效）；若配置回退到 node 环境运行，M0 不算完成。
- 覆盖矩阵与清单文件由脚本生成；若被手工编辑导致条目缺失，脚本必须以非 0 退出。矩阵中任何 `exempt` 空理由都视为失败。

### M1 身份与账号（REQ-0001-003/004/005）

**范围**：多租户（每租户一套 server key 与派生签名密钥，数据按 `tenant_id` 隔离，见 [ECN-0001](../ecn/ECN-0001-multi-tenancy.md)）、服务端密钥鉴权（Basic）、设备/邮箱/自定义认证、access/refresh 令牌、会话过期与登出、用户资料读写。

**DoD**

| # | DoD | 验证命令 | 预期 |
|---|---|---|---|
| 1 | `POST /v2/account/authenticate/device?create=true` 返回 200，body 含 `token`/`refresh_token`，用户 `id` 为 UUIDv4 大写格式 | `npm test`（集成） | 断言全绿 |
| 2 | 无 `Authorization` 头或错误密钥 → 401 | 同上 | 断言全绿 |
| 3 | 冲突与重复语义与上游一致：**用户名**撞车 → `409 Username is already in use.`；**同邮箱二次认证**按上游行为走登录（200，不是 409）；错密码 → `401 Invalid credentials.` | 同上 | 断言全绿 |
| 4 | 过期/伪造 token → 401；refresh 后可换发新 access token；登出（`/v2/session/logout`）后旧 token 失效 | 同上 | 断言全绿 |
| 5 | 资料读取/更新字段级一致（username、display_name、avatar_url、lang_tag、location、timezone、metadata） | 同上 | 断言全绿 |
| 6 | E2E：设备登录 → 带 token 读资料 → 改显示名 → 再读回，全流程在真实 HTTP 面完成 | `npm run e2e` | 退出码 0 |
| 7 | 覆盖矩阵中与账号/认证相关的上游测试条目状态不再为 `planned` | `npm run conformance:matrix` | 无 `planned` 残留于 M1 范围 |
| 8 | 多租户隔离：同账号建两个租户；A 租户令牌在 B 租户被拒（401）；同名用户在两租户下共存；未知 server key → 401 `Server key invalid` | `npm test` | 断言全绿 |
| 9 | 未实现但上游存在的 REST 路径返回 501（不是 404），未知路径仍为 404 | `npm test` | 断言全绿 |
| 10 | 与上游的刻意偏差必须有 ECN 并从 PRD / 计划 / 覆盖矩阵三处可追 | `npm run docs:check` + 人工核对 `docs/ecn/` | 退出码 0；ECN-0002（密码哈希）、ECN-0003（401 realm）在 PRD 与计划里都有引用 |

### M2 存储引擎（REQ-0001-006/007）

**范围**：集合/对象 CRUD、写入权限（owner/read/write 权限位）、version 乐观锁、批量写、游标分页读取、存储索引查询。

**DoD**

| # | DoD | 验证命令 | 预期 |
|---|---|---|---|
| 1 | 对象 CRUD 语义对齐：`write` 返回 `version`，重复写递增，`If-Match` 版本冲突返回与上游一致的错误 | `npm test` | 断言全绿 |
| 2 | 权限矩阵：私有对象对其他用户读/写均被拒；`public read` 只读可读；owner-only 写 | 同上 | 断言全绿（矩阵逐格覆盖） |
| 3 | 批量写 100 条 = 全部成功或全部失败（无部分写入） | 同上 | 断言全绿 |
| 4 | 游标分页：造 10,000 条对象，翻页遍历无重复、无遗漏、总数一致 | `npm run e2e` | 退出码 0，断言 total 与去重计数相等 |
| 5 | 存储索引查询返回集合与顺序与上游一致（多字段 AND/OR、排序、游标） | `npm test` | 断言全绿 |
| 6 | 覆盖矩阵中 `core_storage_test.go`（54 条）与 `storage_index_test.go`（3 条）相关条目状态不再为 `planned` | `npm run conformance:matrix` | 无 `planned` 残留于 M2 范围 |

### M3 实时协议骨架与在线状态（REQ-0001-008/009）

**范围**：`/ws` 握手与鉴权、二进制 `Envelope` 编解码、`ping`/`pong`、错误帧、会话注册表、状态订阅与 presence。

**DoD**

| # | DoD | 验证命令 | 预期 |
|---|---|---|---|
| 1 | 用上游 `realtime.proto` 生成的编解码器完成往返，字节级可解析 | `npm test` | 断言全绿（含 51 消息类型的编解码冒烟） |
| 2 | 未带合法 token 的握手被拒；伪造/截断帧返回对齐的错误码（`BAD_INPUT` / `UNRECOGNIZED_PAYLOAD`） | 同上 | 断言全绿 |
| 3 | `ping` → `pong` 往返，`cid` 原样回带 | 同上 | 断言全绿 |
| 4 | 同一用户两条连接：A 订阅 B 的状态 → B 上线/下线各产生一次 presence 事件（不丢不重） | `npm run e2e` | 退出码 0 |
| 5 | 客户端断开后，注册表在超时阈值内清理该会话（可观测：状态订阅者收到 leave） | `npm run e2e` | 退出码 0 |

### M4 频道与会话内聊天（REQ-0001-010）

**范围**：ROOM / GROUP / DIRECT 三类频道、加入/离开、presence、消息发送/编辑/删除、持久化与历史分页。

**DoD**

| # | DoD | 验证命令 | 预期 |
|---|---|---|---|
| 1 | 三类频道的 join/leave 与 presence 事件语义对齐上游 | `npm test` | 断言全绿 |
| 2 | 持久化频道消息在断开重连后可读到（历史），非持久化频道不落盘 | 同上 | 断言全绿 |
| 3 | 消息编辑/删除：仅发送者可改删；他人操作返回对齐错误 | 同上 | 断言全绿 |
| 4 | E2E：两个客户端进同一 ROOM，互发 10 条消息，顺序与内容完全一致，第三个客户端后进可读历史 | `npm run e2e` | 退出码 0 |
| 5 | M4 没有可搬运的上游测试（上游没有频道 API 的测试文件，见 `milestone-scope.json` 里 M4 的说明），对齐证据改由第二证据源承担：矩阵的「第二证据源」段必须出现至少一条频道相关的 swagger 路径引用 | `npm run conformance:matrix` | 第二证据源段含 `/v2/channel` 路径引用 |

## 计划索引

| 计划 | 覆盖里程碑 | Req ID |
|---|---|---|
| [v1-foundation.md](./v1-foundation.md) | M0 | REQ-0001-001, REQ-0001-002 |
| [v1-identity-storage.md](./v1-identity-storage.md) | M1, M2 | REQ-0001-003~007 |
| [v1-realtime-chat.md](./v1-realtime-chat.md) | M3, M4 | REQ-0001-008~010 |

## 追溯矩阵

| Req ID | v1 计划 | 单元/集成测试 | E2E | 证据 | 状态 |
|---|---|---|---|---|---|
| REQ-0001-001 | v1-foundation Step1-4 | `tests/unit/grpc_status.test.ts`（18 条）、`tests/unit/runtime.test.ts`（1 条 workerd 门禁）、`tests/integration/healthcheck.test.ts`（3 条） | `tests/e2e/toolchain.e2e.test.ts`（4 条） | [v1-foundation.md §Evidence A–E](./v1-foundation.md#evidence) | 🟢 done |
| REQ-0001-002 | v1-foundation Step1-4 | `tests/integration/healthcheck.test.ts`（3 条：根路径 / healthcheck / 未知路径） | `tests/e2e/toolchain.e2e.test.ts`（4 条，含 501 语义） | [v1-foundation.md §Evidence A–E](./v1-foundation.md#evidence) | 🟢 done |
| REQ-0001-003 | v1-identity-storage M1 | `tests/integration/identity/authenticate-device-custom.test.ts`（12 条）、`tests/integration/identity/authenticate-email.test.ts`（10 条）、`tests/integration/identity/base-and-auth-server.test.ts`（10 条：服务端密钥鉴权与基础面） | `tests/e2e/identity.e2e.test.ts`（14 条中的认证/401/501 组） | [v1-identity-storage.md §Evidence A/B/D](./v1-identity-storage.md#evidence)、[ECN-0002](../ecn/ECN-0002-password-hash.md) | 🟢 done |
| REQ-0001-004 | v1-identity-storage M1 | `tests/integration/identity/session-and-account.test.ts`（13 条：令牌与会话 / 账号资料）、`tests/integration/identity/user-query-and-logout.test.ts`（8 条：用户查询与登出） | `tests/e2e/identity.e2e.test.ts`（刷新换发、刷新令牌不可当访问令牌、登出后失效） | [v1-identity-storage.md §Evidence A/B](./v1-identity-storage.md#evidence)、[ECN-0003](../ecn/ECN-0003-www-authenticate-realm.md) | 🟢 done |
| REQ-0001-005 | v1-identity-storage M1 | `tests/integration/identity/session-and-account.test.ts`（账号资料）、`tests/integration/identity/user-query-and-logout.test.ts`（用户查询） | `tests/e2e/identity.e2e.test.ts`（改显示名 → 读回、`/v2/user` 批量查询） | [v1-identity-storage.md §Evidence A/B](./v1-identity-storage.md#evidence) | 🟢 done |
| REQ-0001-026 | v1-identity-storage M1（[ECN-0001](../ecn/ECN-0001-multi-tenancy.md)） | `tests/integration/tenancy.test.ts`（7 条）、`tests/unit/tenancy_keys.test.ts`（8 条） | `tests/e2e/identity.e2e.test.ts`（多租户隔离 3 条，真实 HTTP） | [v1-identity-storage.md §Evidence B/E](./v1-identity-storage.md#evidence) | 🟢 done |
| REQ-0001-006 | v1-identity-storage M2 | `tests/unit/md5.test.ts`（5 条）、`tests/integration/storage/`（12 个文件 / 74 条，其中对象侧 59 条：CRUD、权限矩阵、版本矩阵、批量原子性、游标分页） | `tests/e2e/storage.e2e.test.ts`（2 条：写→读回→md5 版本交叉验证；10,000 条翻页不重不漏） | [v1-identity-storage.md §Evidence M2-A/B/C](./v1-identity-storage.md#evidence) | 🟢 done |
| REQ-0001-007 | v1-identity-storage M2 | `tests/integration/storage/`（索引侧 15 条：`index-write` 4 条 = 上游 4 个 t.Run、`index-list` 6 条 = 上游 4 个 t.Run + 删除 + 偏差 1、`index-cursor` 5 条 = 游标与校验边界） | 无独立 E2E（索引是运行时而接口，没有公开 REST 端点；DoD 5 要求的是 `npm test`） | [v1-identity-storage.md §Evidence M2-C/D](./v1-identity-storage.md#evidence)、[ECN-0004](../ecn/ECN-0004-storage-cursor-encoding.md)、[ECN-0005](../ecn/ECN-0005-storage-index.md) | 🟢 done |
| REQ-0001-008 | v1-realtime-chat M3 | 待填 | 待填 | — | 🔴 todo |
| REQ-0001-009 | v1-realtime-chat M3 | 待填 | 待填 | — | 🔴 todo |
| REQ-0001-010 | v1-realtime-chat M4 | 待填 | 待填 | — | 🔴 todo |

> 任何 `待填` / `—` 都是断链，禁止在存在断链的情况下宣称对应需求已交付。

## ECN 索引

| ECN | 标题 | 状态 | 关联 Req ID | 落点 |
|---|---|---|---|---|
| [ECN-0001](../ecn/ECN-0001-multi-tenancy.md) | 多租户（一个 Cloudflare 账号运营多个游戏） | 已生效（M1 前落地） | REQ-0001-026 | `migrations/0001_identity.sql`、`src/domain/tenancy/store.ts`、`src/http/auth.ts`、`scripts/tenant.mjs` |
| [ECN-0002](../ecn/ECN-0002-password-hash.md) | 密码哈希改用 PBKDF2-SHA256 | 已生效 | REQ-0001-003 | `src/domain/identity/password.ts` |
| [ECN-0003](../ecn/ECN-0003-www-authenticate-realm.md) | 401 挑战头的 realm 用本项目命名 | 已生效 | REQ-0001-004 | `src/http/grpc.ts` |
| [ECN-0004](../ecn/ECN-0004-storage-cursor-encoding.md) | 存储游标改用 base64url(JSON) 而不是 gob | 已生效 | REQ-0001-006, REQ-0001-007 | `src/domain/storage/cursor.ts`、`src/domain/storage/index/cursor.ts` |
| [ECN-0005](../ecn/ECN-0005-storage-index.md) | 存储索引从 bluge 内存索引换成对权威表的声明式查询 | 已生效 | REQ-0001-007 | `migrations/0002_storage.sql`、`src/domain/storage/index/*.ts` |

## Review 记录

## Tashan Review - v1 / M0

- reviewer_context: same-model（**非** fresh 上下文，见下方 NOTE 与残余风险）
- round: 1
- cost_profile: standard
- verdict: pass
- blocker_count: 0
- major_count: 1（已修复）
- stuck_signatures: 无
- regression_signatures: 无
- commands_checked:
  - `npm test` → 0（3 files / 22 tests，含 workerd 运行时身份门禁）
  - `npm run typecheck` → 0
  - `npm run e2e` → 0（1 file / 4 tests，日志含真实监听地址）
  - `MUSTER_E2E_TARGET=http://127.0.0.1:8799 npm run e2e` → 1（4 条全 ECONNREFUSED，反证 E2E 非进程内直调）
  - `npm run conformance:inventory` → 0（`upstream_tests=263 mode=verify`）
  - `npm run conformance:matrix` → 0（`unreasoned_exemptions=0`）；伪造手工编辑后再跑 → 1
  - `npm run docs:check` → 0（`problems=0`）；把单文件计数改错后再跑 → 1
  - 上游语义核对：`server/api.go`（`grpcGatewayRouter` / `handleRoutingError`）、`vendor/.../runtime/errors.go`（`HTTPStatusFromCode`，含 `FailedPrecondition → 400` 的原文注释）→ 与实现一致
  - 统计复核：由 `baseline.json` 聚合得 40 个测试文件 / 263 个 `Test*` / 存储 54+3=57，与文档数字一致
- residual_risks:
  1. 本轮 Review 是**同模型自评**，存在橡皮图章风险；缓解：所有关键结论都落成可复现命令与永久化门禁，而非"我看过觉得没问题"。
  2. E2E 就绪判定只看 `GET /healthcheck` 是否 200，理论上可能被半启动状态骗过（当前不可复现）；M1 的 E2E 会额外断言 JSON body，届时该项自然收敛。
  3. 无线上部署验收（本机无 Docker、无 Cloudflare 资源），M0 的"能跑"仅指本地 workerd + 真实 HTTP。

### Findings

| severity | signature | evidence | disposition |
|---|---|---|---|
| MAJOR | docs::v1-identity-storage::stale-test-count | 该文件原写"存储……58 条"，而 `baseline.json` 聚合为 `core_storage_test.go` 54 + `storage_index_test.go` 3 = 57 | 已修：改为具名计数；并给 `doc_hygiene_check.py` 新增"单文件计数对账"闸门（反证：改成 58 → 退出码 1） |
| MINOR | artifacts::docs/conformance/upstream-inventory.md::local-path-leak | 生成物表头写入作者本地绝对路径（含用户名），而该文件进公共仓库 | 已修：只写相对本仓库的路径 `../nakama`，重新生成后 `git status` 干净 |
| MINOR | verification::M0-anti-cheat-2::manual-only-gate | 反作弊条款 2「测试必须跑在 workerd」此前没有任何自动化检查 | 已修：新增 `tests/unit/runtime.test.ts`，断言 `navigator.userAgent === "Cloudflare-Workers"` |
| NOTE | review::M0::same-model-self-review | 派出的独立 reviewer 子代理两次未收到任务正文（其回话为"任务还没来"），本轮无法获得 fresh 上下文 | 已记录残余风险 1；Review 结论全部以命令证据支撑 |
| NOTE | e2e::tests-e2e-global-setup::readiness-heuristic | 就绪判定仅 `res.status === 200`，不校验 body | 携带至 M1 处理（见残余风险 2） |

## Tashan Review - v1 / M1

- reviewer_context: same-model（自评；本机无法派出独立子代理——两次尝试的子代理都没收到任务正文，见下方 NOTE）
- round: 1
- cost_profile: standard
- verdict: pass
- blocker_count: 0
- major_count: 0
- stuck_signatures: 无
- regression_signatures: 无
- commands_checked:
  - `npm test` → 0（6 files / 90 tests；`tests/unit/runtime.test.ts` 断言 `navigator.userAgent === "Cloudflare-Workers"`，证明这 90 条确实跑在 workerd 里）
  - `npm run typecheck` → 0
  - `npm run e2e` → 0（2 files / 18 tests，含多租户隔离 3 条；日志含真实监听地址 `http://127.0.0.1:8788`）
  - `$env:MUSTER_E2E_TARGET='http://127.0.0.1:8799'; npm run e2e` → 1（18 条全 ECONNREFUSED，反证 E2E 走的是网络而不是进程内直调）
  - `npm run conformance:inventory` → 0（`upstream_files=40 upstream_tests=263 upstream_commit=e920249a...` mode=verify）
  - `npm run conformance:matrix` → 0（`entries=263 ported=1 planned=262 exempt=0 unreasoned_exemptions=0`；M1 桶 1/1/0/0 → 本里程碑范围无 `planned` 残留）
  - `npm run docs:check` → 0（`files=12 requirements=26 plans=3 lines=1774 links=40 problems=0`）
  - 上游语义核对：`server/api.go`（`securityInterceptorFunc`/`parseBasicAuth`/`parseBearerAuth`/`wwwAuthenticateFixWriter`/`handleRoutingError`）、`server/api_authenticate.go::AuthenticateEmail`、`server/core_authenticate.go::AuthenticateEmail|AuthenticateUsername`、`server/api_session.go::SessionRefresh|SessionLogout`、`server/api_account.go::GetAccount`、`server/core_account.go::GetAccount`、`server/api_user.go`、`apigrpc/apigrpc.swagger.json` → 状态码、错误消息、字段名、校验顺序逐条比对，未发现不一致
  - 多租户隔离核查：`rg -n "prepare\(" src/domain/identity/store.ts src/domain/tenancy/store.ts` → 所有用户/身份/资料的 SELECT/INSERT/UPDATE 都带 `tenant_id`；唯一按 `token_id` 全局查改的是 `sessions`，已按下方 MINOR 处置
  - 目录卫生：`git status --porcelain` 在提交后为空
- residual_risks:
  1. 本轮 Review 是**同模型自评**：本机派出独立子代理两次都失败（子代理回复"没收到任务正文"），因此没有新鲜上下文的对抗式检查。缓解：结论全部落成可复现命令与永久化门禁（覆盖矩阵脚本、文档卫生脚本、workerd 运行时门禁、E2E 反证），不依赖"我看过"。
  2. 没有线上部署验收：受"测试不得依赖 Cloudflare 远端资源"的约束，M1 的"能跑"指的是本地 workerd + 真实 HTTP。
  3. `GET /v2/user` 的 `facebook_ids` 参数永远返回空集合（社交登录后置到 v2，M1 不可能有 facebook 身份）。这不是掩盖：上游"查不到"的响应形状同样是空集合，v2 补身份来源即可。

### Findings

| severity | signature | evidence | disposition |
|---|---|---|---|
| MINOR | tenancy::sessions::missing-tenant-predicate | `src/domain/identity/store.ts` 的 `findSession`/`revokeSession` 只按 `token_id` 全局查改；跨租户隔离真正依赖的是"令牌签名密钥按租户派生"这一层，数据库层缺纵深防御 | 已修复（commit `22e139b`）：`insertSession` 的冲突分支加 `WHERE sessions.tenant_id/user_id = <传入值>`，写成 0 行即抛错；`findSession`/`revokeSession` 谓词加 `tenant_id`；90 条测试仍全绿 |
| MINOR | dod::M1::email-duplicate-409-wrong | M1 DoD #3 原写"邮箱认证重复注册 → 冲突码与上游一致（409）"，而上游 `server/core_authenticate.go::AuthenticateEmail` 对已存在邮箱是**校验密码后登录**（200/401），409 只出现在**用户名**撞车 | 已改写 DoD #3 为"用户名撞车 → 409；同邮箱二次认证走登录；错密码 → 401"，并在 `tests/integration/identity.test.ts` 的两条对应用例中钉住 |
| MINOR | conformance::M1-scope::google-token-tests-misbucketed | `social/google_token_audience_test.go`（3 条）原本挂在 M1 桶，但 PRD 与 v1 计划都把 OAuth/社交登录后置到 v2——留在 M1 只会逼出"提前做 v2"或"把对外可观测行为当豁免"两种坏结果 | 已重归类到 M5 桶，并在 `milestone-scope.json` 的 M1/M5 条目里写明理由、同步 PRD（REQ-0001-003 备注 + §7 里程碑表） |
| NOTE | parity::account::verify-time-and-wallet | 核对上游 `core_account.go::GetAccount`：邮箱建号**不写** `verify_time`（INSERT 只有 id/username/email/password/create_time/update_time）；`wallet` 是建表默认 `{}`；`ApiServer.GetAccount` 显式清空 `DisableTime` | 已核对，未发现偏差：`src/wire/identity.ts` 不发 `disable_time`、`verify_time` 仅在非 0 时发、`wallet` 固定 `"{}"` |
| NOTE | e2e::readiness-heuristic | M0 的残余风险 2（就绪判定只看状态码）已在 M1 闭合：`tests/e2e/global-setup.ts` 现在要求 `GET /healthcheck` 的 body 精确等于 `{}` | 已闭合，本条从残余风险降级为观察记录 |
| NOTE | review::M1::same-model-self-review | 本机子代理派发失败（两次都收到"没有任务正文"的回话），本轮没有 fresh 上下文 Review | 见残余风险 1；若后续环境允许派发，应补一次独立对抗式 Review |

## Tashan Review - v1 / M2

- reviewer_context: same-model（自评；本机无法派出独立子代理，同 M0/M1，见下方 NOTE）
- round: 1
- cost_profile: standard
- verdict: pass
- blocker_count: 0
- major_count: 0
- minor_count: 2（均已在提交前修复）
- stuck_signatures: 无
- regression_signatures: 无
- commands_checked:
  - `npm test` → 0（23 files / 169 tests；`tests/unit/runtime.test.ts` 仍断言 `navigator.userAgent === "Cloudflare-Workers"`，证明这 169 条跑在 workerd 里）
  - `npm run typecheck` → 0
  - `npm run e2e` → 0（3 files / 20 tests，110s；其中 10,000 条翻页用例实测 85s，预算 900s）
  - `$env:MUSTER_E2E_TARGET='http://127.0.0.1:8799'; npm run e2e` → 1（20 条全 ECONNREFUSED，反证 E2E 走的是网络而不是进程内直调）
  - `npm run conformance:matrix` → 0（`entries=263 ported=58 planned=205 exempt=0 unreasoned_exemptions=0 derived_citations=32`；M2 桶 57/57/0/0）
  - `npm run docs:check` → 0（`problems=0`）
  - **bluge 独立探针**（临时目录，不入仓库）：内存索引里同一 batch 内三次 `Update`（后两次同 doc id）→ `Reader.Count()` = 3；同样两次 `Update` 拆成两个 batch → 1。这条决定了"上游分页用例的第三页从哪来"
  - 上游语义核对：`server/storage_index.go`（`Write` / `Delete` / `List` / `CreateIndex` / `mapIndexStorageFields` / `storageIndexDocumentId`）、`server/match_common.go`（`ParseQueryString` / `BlugeWalkDocument`）、`server/core_storage.go`（upsert 的 `ON CONFLICT ... DO UPDATE ... AND NOT (...)`）→ 逐条比对
  - `git status --porcelain` 在提交后为空
- residual_risks:
  1. 同模型自评的橡皮图章风险（与 M0/M1 相同）。缓解：每条结论都落成可复现命令或永久门禁，不依赖"我看过觉得没问题"。
  2. 索引查询只实现了存储索引实际用到的语法子集（[ECN-0005](../ecn/ECN-0005-storage-index.md) §偏差 4）。未实现的语法一律报 `invalid` 而不是静默降级；如果上游将来在别处复用这套索引语法，需要同步扩语法。
  3. 10,000 条 E2E 用时 85s 是**本机**实测；更慢的机器上要调那条用例的 `timeout`（当前 900s）。
  4. 淘汰的决胜键（ECN-0005 §偏差 2）依赖秒级时间戳：同一秒内写入多条且恰好越过淘汰线时，保留哪几条可能与上游不同（已登记）。

### Findings

| severity | signature | evidence | disposition |
|---|---|---|---|
| MINOR | index::sort::direction-only-on-last-segment | `sortExpressionForField` 把三段表达式拼成一个字符串返回，`orderFragment` 只给整串加一次方向 → `-value.sort` 实际按升序返回。由 `index-list` 的 `-value.sort` 断言抓到（返回 `[one, three]` 而不是 `[three, one]`） | 已修复（commit `46597d8`）：改成返回表达式数组、逐段加方向 |
| MINOR | conformance::citations::method-symbol-unverified | 校验器对 `契约源: server/storage_index.go::LocalStorageIndex.List` 报"符号在上游文件里找不到"——Go 方法的声明形状是 `func (si *LocalStorageIndex) List(`，裸子串匹配认不出，会逼出"把方法引用写成不存在的东西"这种坏习惯 | 已修复（commit `46597d8`）：`scripts/conformance-matrix.mjs` 增加方法声明形状核对（方法名写错仍会被拦下） |
| NOTE | parity::index::batch-shadowing | bluge 的 `Batch.Update` 删不掉"同批内先写入的同 id 文档"，上游 `TestLocalStorageIndex_List/paginates correctly` 的第三页正是这条残留；我们用独立探针复现（见 commands_checked） | **不复刻**（[ECN-0005](../ecn/ECN-0005-storage-index.md) §偏差 1）：它返回的是权威表里已不存在的旧值。已落成显式用例 `test_overwriting_the_same_object_in_one_batch_leaves_no_stale_entry` + 等价场景的三页分页断言 |
| NOTE | test::isolation::shared-tenant | 同一测试文件内多个用例共用同一个 D1 租户：前一个用例失败留下的行会污染后一个（实测：`createIndex` 报重名 `AlreadyExists`、删除用例看到 3 条而不是 2 条） | 已修复：索引用例改成"每个用例独立索引名 + 独立集合名"，并在注释里写明理由 |
| NOTE | review::M2::same-model-self-review | 与 M0/M1 同样的限制 | 见残余风险 1；环境允许时应补一次独立对抗式 Review |

## Tashan Trigger Audit

```markdown
- expected_review_triggers: v_doc_writing_done, v_milestone_done(M0..M4)
- actual_review_runs: 4 (v_doc_writing_done, v_milestone_done(M0) 同模型自评, v_milestone_done(M1) 同模型自评, v_milestone_done(M2) 同模型自评)
- skipped_triggers: 0
- skip_reasons: 独立子代理派发不通（本机限制），降级为同模型自评 + 命令证据
- mitigation: 每个里程碑完成前必须补 Review 记录，否则不输出完成信号；把可自动化的检查固化成脚本门禁（覆盖矩阵、文档卫生、workerd 运行时、E2E 反证），降低对人工 Review 的依赖
```

## 差异列表（v1 结束后回填）

待填。
