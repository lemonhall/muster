# v1 计划索引 — Muster 地基、身份、存储、实时骨架

| 项目 | 内容 |
|---|---|
| 版本 | v1 |
| 日期 | 2026-09-28 |
| 状态 | 已完成（v1 = M0–M4，全部门禁绿；完成信号见各里程碑 Evidence 与 Review 记录） |
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
| 1 | 用上游 `realtime.proto` 生成的编解码器完成往返，字节级可解析 | `npm test` | 断言全绿（含 `Envelope` 全部 50 个消息类型的编解码冒烟 + 与独立实现 `protobufjs` 的黄金向量逐字节比对） |
| 2 | 未带合法 token 的握手被拒；伪造/截断帧返回对齐的错误码（`BAD_INPUT` / `UNRECOGNIZED_PAYLOAD`） | 同上 | 断言全绿 |
| 3 | `ping` → `pong` 往返，`cid` 原样回带 | 同上 | 断言全绿 |
| 4 | 同一用户两条连接：A 订阅 B 的状态 → B 上线/下线各产生一次 presence 事件（不丢不重） | `npm run e2e` | 退出码 0 |
| 5 | 客户端断开后，注册表在超时阈值内清理该会话（可观测：状态订阅者收到 leave） | `npm run e2e` | 退出码 0 |

### M4 频道与会话内聊天（REQ-0001-010）

**范围**：ROOM / GROUP / DIRECT 三类频道、加入/离开、presence、消息发送/编辑/删除、持久化与历史分页。

**DoD**

| # | DoD | 验证命令 | 预期 | 状态 |
|---|---|---|---|---|
| 1 | 三类频道的 join/leave 与 presence 事件语义对齐上游 | `npm test` | 断言全绿 | ✅ done |
| 2 | 持久化频道消息在断开重连后可读到（历史），非持久化频道不落盘 | 同上 | 断言全绿 | ✅ done |
| 3 | 消息编辑/删除：仅发送者可改删；他人操作返回对齐错误 | 同上 | 断言全绿 | ✅ done |
| 4 | E2E：两个客户端进同一 ROOM，互发 10 条消息，顺序与内容完全一致，第三个客户端后进可读历史 | `npm run e2e` | 退出码 0 | ✅ done |
| 5 | M4 没有可搬运的上游测试（上游没有频道 API 的测试文件，见 `milestone-scope.json` 里 M4 的说明），对齐证据改由第二证据源承担：矩阵的「第二证据源」段必须出现至少一条频道相关的 swagger 路径引用 | `npm run conformance:matrix` | 第二证据源段含 `/v2/channel` 路径引用 | ✅ done |

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
| REQ-0001-008 | v1-realtime-chat M3 | `tests/integration/realtime/envelope.test.ts`（8 条）、`handshake.test.ts`（7 条）、`pipeline-basics.test.ts`（7 条）、`session-lifecycle.test.ts`（7 条中的元数据/心跳组） | `tests/e2e/realtime.e2e.test.ts`（5 条中的两种线格式 ping/pong 与未接通类型） | [v1-realtime-chat.md §Evidence M3-A/C](./v1-realtime-chat.md#evidence)、[ECN-0006](../ecn/ECN-0006-realtime-on-durable-objects.md) | 🟢 done |
| REQ-0001-009 | v1-realtime-chat M3 | `tests/integration/realtime/pipeline-status.test.ts`（13 条）、`registry.test.ts`（7 条：真实 DO + 真实 WebSocket）、`session-lifecycle.test.ts`（7 条：心跳 / 兜底清理 / 幂等清理） | `tests/e2e/realtime.e2e.test.ts`（订阅 → 状态变更 → 上下线通知；后到订阅者的当前快照） | [v1-realtime-chat.md §Evidence M3-B/C](./v1-realtime-chat.md#evidence)、[ECN-0006](../ecn/ECN-0006-realtime-on-durable-objects.md) | 🟢 done |
| REQ-0001-010 | v1-realtime-chat M4 | `tests/integration/channel/`（6 个文件 / 66 条：`ids` 14 条 = 频道 id 构造与解析、字节级限长、解析比建频道更宽松；`validation` 16 条 = 五类帧的校验顺序与错误码；`join` 8 条 = 三类频道 join/leave、看不见自己、hidden、persistence；`messages` 10 条 = 广播与回执顺序、改删权限、非持久化不落盘；`presence` 6 条 = leave 事件、幂等 leave、hidden 离开、断开清理、跨租户同名房间；`history` 12 条 = 线格式、limit 缺省 1、正反翻页、游标、准入、未鉴权） | `tests/e2e/realtime-chat.e2e.test.ts`（3 条：两客户端同房间互发 10 条且顺序与内容一致、第三个客户端后进读历史、非持久化房间不落盘） | [v1-realtime-chat.md §Evidence M4-A/B/C](./v1-realtime-chat.md#evidence)、[ECN-0007](../ecn/ECN-0007-channels-on-durable-objects.md) | 🟢 done |

> 任何 `待填` / `—` 都是断链，禁止在存在断链的情况下宣称对应需求已交付。

## ECN 索引

| ECN | 标题 | 状态 | 关联 Req ID | 落点 |
|---|---|---|---|---|
| [ECN-0001](../ecn/ECN-0001-multi-tenancy.md) | 多租户（一个 Cloudflare 账号运营多个游戏） | 已生效（M1 前落地） | REQ-0001-026 | `migrations/0001_identity.sql`、`src/domain/tenancy/store.ts`、`src/http/auth.ts`、`scripts/tenant.mjs` |
| [ECN-0002](../ecn/ECN-0002-password-hash.md) | 密码哈希改用 PBKDF2-SHA256 | 已生效 | REQ-0001-003 | `src/domain/identity/password.ts` |
| [ECN-0003](../ecn/ECN-0003-www-authenticate-realm.md) | 401 挑战头的 realm 用本项目命名 | 已生效 | REQ-0001-004 | `src/http/grpc.ts` |
| [ECN-0004](../ecn/ECN-0004-storage-cursor-encoding.md) | 存储游标改用 base64url(JSON) 而不是 gob | 已生效 | REQ-0001-006, REQ-0001-007 | `src/domain/storage/cursor.ts`、`src/domain/storage/index/cursor.ts` |
| [ECN-0005](../ecn/ECN-0005-storage-index.md) | 存储索引从 bluge 内存索引换成对权威表的声明式查询 | 已生效 | REQ-0001-007 | `migrations/0002_storage.sql`、`src/domain/storage/index/*.ts` |
| [ECN-0006](../ecn/ECN-0006-realtime-on-durable-objects.md) | 实时层建在 Durable Object 上（会话分片 + 每租户注册表） | 已生效 | REQ-0001-008, REQ-0001-009 | `src/durable/{session-shard,session-registry,session-store}.ts`、`src/realtime/*.ts`、`src/http/routes/socket.ts`、`wrangler.jsonc` |
| [ECN-0007](../ecn/ECN-0007-channels-on-durable-objects.md) | 频道与会话内聊天建在"每频道一个 Durable Object"上 | 已生效 | REQ-0001-010 | `src/durable/{channel,channel-core,channel-members,channel-messages,channel-history,channel-access,channel-fanout,session-channels}.ts`、`src/realtime/{channel,channel-ids,channel-cursor,pipeline-channel}.ts`、`src/http/routes/channel.ts`、`wrangler.jsonc` |

## Tashan Review 记录

每个里程碑的 Review 记录单独成文（单文件体量约束，见全局宪法《单个文件长度》）：

| 里程碑 | Review 记录 |
|---|---|
| M0 | [../reviews/v1-M0.md](../reviews/v1-M0.md) |
| M1 | [../reviews/v1-M1.md](../reviews/v1-M1.md) |
| M2 | [../reviews/v1-M2.md](../reviews/v1-M2.md) |
| M3 | [../reviews/v1-M3.md](../reviews/v1-M3.md) |
| M4 | [../reviews/v1-M4.md](../reviews/v1-M4.md) |

## Tashan Trigger Audit

```markdown
- expected_review_triggers: v_doc_writing_done, v_milestone_done(M0..M4)
- actual_review_runs: 6 (v_doc_writing_done, v_milestone_done(M0) 同模型自评, v_milestone_done(M1) 同模型自评, v_milestone_done(M2) 同模型自评, v_milestone_done(M3) 同模型自评, v_milestone_done(M4) 同模型自评)
- skipped_triggers: 0
- skip_reasons: 独立子代理派发不通（本机限制），降级为同模型自评 + 命令证据
- mitigation: 每个里程碑完成前必须补 Review 记录，否则不输出完成信号；把可自动化的检查固化成脚本门禁（覆盖矩阵、文档卫生、workerd 运行时、E2E 反证），降低对人工 Review 的依赖
```

## 差异列表（v1 结束时回填）

v1 与上游的**全部**刻意差异都登记在 ECN 里，这里只做索引与"客户端看不看得见"的分类。

| ECN | 差异 | 客户端可见？ | 处置 |
|---|---|---|---|
| [ECN-0001](../ecn/ECN-0001-multi-tenancy.md) | 一个部署运营多个游戏：数据按租户隔离，每租户一套 server key 与签名密钥 | 可见（请求必须带本租户的 server key） | 已生效；上游没有对应能力，属**增强** |
| [ECN-0002](../ecn/ECN-0002-password-hash.md) | 密码哈希用 PBKDF2-SHA256 而不是 bcrypt | 不可见 | 已生效；代价是**不能**把上游库里的密码哈希直接搬过来 |
| [ECN-0003](../ecn/ECN-0003-www-authenticate-realm.md) | 401 挑战头的 realm 用本项目命名 | 可见（仅文案差异） | 已生效 |
| [ECN-0004](../ecn/ECN-0004-storage-cursor-encoding.md) | 存储游标是 base64url(JSON) 而不是 gob | 不可见（游标不透明） | 已生效；代价是本项目与上游的游标不能互换 |
| [ECN-0005](../ecn/ECN-0005-storage-index.md) | 存储索引从内存索引换成对权威表的声明式查询 | 不可见 | 已生效 |
| [ECN-0006](../ecn/ECN-0006-realtime-on-durable-objects.md) | 实时层建在 DO 上（会话分片 + 每租户注册表）；保活从 WS 控制帧换成心跳 + 巡检 | 部分可见（收不到服务端控制帧 ping，也不会因为长时间不出声被断开） | 已生效；含 5 条子偏差 |
| [ECN-0007](../ecn/ECN-0007-channels-on-durable-objects.md) | 频道建在"每频道一个 DO"上；消息时间戳毫秒且频道内单调；巡检闹钟 | 部分可见（同毫秒连发时时间戳被推后；私聊首次加入少一条通知） | 已生效；含 7 条子偏差 |

两处**临时**状态也一并说清，免得被读成"永远如此"：

1. M3 那条"未接通的消息类型一律 `UNRECOGNIZED_PAYLOAD` + 关连接"（ECN-0006 偏差 3）已经不是全貌：
   M4 把频道五类帧接通了；对局、派对、RPC、流等类型仍留待后续里程碑（M6–M8）。
2. v1 全程只在**本地 workerd** 上验证，没有部署到真实 Cloudflare 账号（E2E 不许碰远端资源的预算约束），
   因此 DO 的休眠/唤醒、真实边缘的跨实例投递时延、平台驱逐后的恢复这三件事仍属未验证，
   逐条登记在 [v1-M3.md](../reviews/v1-M3.md) 与 [v1-M4.md](../reviews/v1-M4.md) 的残余风险里。
