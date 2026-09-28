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

**范围**：服务端密钥鉴权（Basic）、设备/邮箱/自定义认证、access/refresh 令牌、会话过期与登出、用户资料读写。

**DoD**

| # | DoD | 验证命令 | 预期 |
|---|---|---|---|
| 1 | `POST /v2/account/authenticate/device?create=true` 返回 200，body 含 `token`/`refresh_token`，用户 `id` 为 UUIDv4 大写格式 | `npm test`（集成） | 断言全绿 |
| 2 | 无 `Authorization` 头或错误密钥 → 401 | 同上 | 断言全绿 |
| 3 | 邮箱认证重复注册 → 冲突码与上游一致（`409`，`code` 字段语义对齐） | 同上 | 断言全绿 |
| 4 | 过期/伪造 token → 401；refresh 后可换发新 access token；登出（`/v2/session/logout`）后旧 token 失效 | 同上 | 断言全绿 |
| 5 | 资料读取/更新字段级一致（username、display_name、avatar_url、lang_tag、location、timezone、metadata） | 同上 | 断言全绿 |
| 6 | E2E：设备登录 → 带 token 读资料 → 改显示名 → 再读回，全流程在真实 HTTP 面完成 | `npm run e2e` | 退出码 0 |
| 7 | 覆盖矩阵中与账号/认证相关的上游测试条目状态不再为 `planned` | `npm run conformance:matrix` | 无 `planned` 残留于 M1 范围 |

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
| REQ-0001-003 | v1-identity-storage M1 | 待填 | 待填 | — | 🔴 todo |
| REQ-0001-004 | v1-identity-storage M1 | 待填 | 待填 | — | 🔴 todo |
| REQ-0001-005 | v1-identity-storage M1 | 待填 | 待填 | — | 🔴 todo |
| REQ-0001-006 | v1-identity-storage M2 | 待填 | 待填 | — | 🔴 todo |
| REQ-0001-007 | v1-identity-storage M2 | 待填 | 待填 | — | 🔴 todo |
| REQ-0001-008 | v1-realtime-chat M3 | 待填 | 待填 | — | 🔴 todo |
| REQ-0001-009 | v1-realtime-chat M3 | 待填 | 待填 | — | 🔴 todo |
| REQ-0001-010 | v1-realtime-chat M4 | 待填 | 待填 | — | 🔴 todo |

> 任何 `待填` / `—` 都是断链，禁止在存在断链的情况下宣称对应需求已交付。

## ECN 索引

暂无。

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

## Tashan Trigger Audit

```markdown
- expected_review_triggers: v_doc_writing_done, v_milestone_done(M0), v_milestone_done(M1..M4)
- actual_review_runs: 2 (v_doc_writing_done, v_milestone_done(M0) 同模型自评)
- skipped_triggers: 0
- skip_reasons: -
- mitigation: 每个里程碑完成前必须补 Review 记录，否则不输出完成信号
```

## 差异列表（v1 结束后回填）

待填。
