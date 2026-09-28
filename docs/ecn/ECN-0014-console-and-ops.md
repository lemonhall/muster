# ECN-0014: 管理台、内购校验与运维面在 Cloudflare 上的载体

## 基本信息

- **ECN 编号**：ECN-0014
- **关联 PRD**：PRD-0001
- **关联 Req ID**：REQ-0001-021（管理台）、REQ-0001-022（内购校验）、
  REQ-0001-023（运维面）
- **发现阶段**：v4-console-ops（M9）计划与编码中
- **日期**：2026-09-29

## 变更原因

上游这一块是四件事拼起来的，其中三件都建立在"本项目没有的载体"上：

1. **控制台会话**：上游 `console/` 有自己的用户体系（`console_user` 表 + 独立的
   JWT 签名密钥 + MFA 强制/重置 + 邀请 token），控制台前端拿这个 JWT 调
   `/v2/console/**` 的 gRPC-gateway 面。
2. **控制台授权**：`console/acl` 是一份**位图权限模型**（每个资源 3 个位：
   read/write/delete）。授权判定分两处：调某个 console RPC 之前查一次
   （`CheckACL` / `CheckACLHttp`），以及两条**运行时规则**——"创建用户时不能给
   别人超过自己的权限"、"重置别人密码前先确认目标权限不越出自己"。
3. **内购校验**：`iap/` 走**厂商 HTTP 端点**（Apple `verifyReceipt`、Google
   Play、Huawei、Facebook Instant）做收据验签。
4. **运维面**：上游是常驻进程，有 Prometheus 抓取端点、结构化日志、限流中间件、
   审计表。

本项目的载体是 Cloudflare Worker：没有常驻进程、没有厂商出网（运行时 isolate
`globalOutbound: null`，主 Worker 也**不**在测试里打厂商端点）、也没有"一个进程内
的全局限流表"。四处都要换载体，而 REQ-0001-021/022/023 的**验收口径**要写实。

## 变更内容

### 原设计

| 上游构件 | 职责 | 载体 |
|---|---|---|
| `console_user` 表 + console JWT + MFA | 控制台账号与会话 | Postgres + 独立签名密钥 |
| `console/acl` 位图 | 权限模型与两条授权规则 | Go 内存位图 + Postgres 行锁 |
| `iap` 四个 provider 校验 | 收据验签 | 厂商 HTTP 端点 |
| Prometheus `/metrics` | 指标导出 | 常驻进程的内存计数器 |
| 限流中间件 | 每接口限流 | 进程内存令牌桶 |
| 审计表 `audit_log` | 管理操作留痕 | Postgres |

### 新设计

| 本项目构件 | 对应上游 | 说明 |
|---|---|---|
| `src/domain/console/acl/*` | `console/acl/acl.go` | 位图权限模型的等价重写（30 资源 × 3 位） |
| `src/domain/console/users/*` | `server/console_user.go` | 两条授权规则 + 建用户 / 重置密码 / 列表 |
| `src/http/routes/console-*.ts` | console gRPC-gateway 面 | 受 tenant server key 保护（偏差 1） |
| `migrations/0007_console.sql` | `console_user` 表 | 多租户首列的等价表 |
| `src/domain/iap/*` | `iap/iap.go` | provider 分派 + Apple verifyReceipt（注入传输层） |
| `src/http/request-id.ts` | 请求 ID 中间件 | 响应头与日志关联 |
| `src/durable/rate-limiter.ts` | 限流中间件 | 每租户一个限流 DO（偏差 4） |

## 偏差清单

| # | 偏差 | 为什么可接受 / 是否客户端可见 |
|---|---|---|
| 1 | 控制台面用 **tenant server key** 鉴权，取代上游的控制台 JWT + MFA 会话 | **客户端可见**（控制台前端要换成 server key，或由自家 BFF 代持）：本项目的管理面定位是"租户运营者"——一个租户的运营者本来就已经持有该租户的 server key，再叠一层 console JWT 只会多一份要运维的密钥。MFA 同样后置 |
| 2 | **指标导出**（Prometheus 抓取）与**多环境**不在本项目载体上 | **非可见**：Worker 无常驻进程可被 `/metrics` 抓取；多环境由"租户 + Cloudflare 环境"承担（ECN-0001）。因此 REQ-0001-023 的验收口径**只取两条**（限流阈值可配 + 日志含请求 ID），指标导出与多环境另走 Cloudflare 原生观测与租户模型 |
| 3 | D1 没有 `SELECT ... FOR UPDATE` | **非可见**：M9 把"读目标 ACL → 授权判定 → 写"放在**同一条串行路径**上（控制台用户的写操作按用户名串行，写前重读校验），而不是靠行锁。上游用例的六格（等权/低权/重试/管理员/畸形/不存在）逐格复现 |
| 4 | 限流桶只活在**限流 DO 的内存里**（不落库） | **非可见**：窗口靠 DO 内存里的计数 + 时间戳滚动；DO 实例被回收即清零，等价于"窗口自然滑过"。每租户一个 DO，租户之间天然隔离 |
| 5 | 内购的厂商调用走**注入的传输层** | **非可见**：默认实现是真 `fetch`（Apple `verifyReceipt`），测试注入假响应。伪造收据（`status != 0`）被拒且不带出任何账本副作用；未配置凭据的 provider 返回明确错误 |
| 6 | 控制台面只实现**最小可信内核**（用户 + ACL + 钱包账本），不是上游整个 console API | **客户端可见**（只覆盖核心操作）：上游 console API 有 90 多个操作，多数依赖 Hiro/Satori 商业面（NS 桶，非目标）。REQ-0001-021 的验收口径是"核心操作可完成" |

## 为什么这些偏差可接受

**可观测语义对齐**：ACL 位图模型的 `Compose` / `HasAccess` / `Admin` / `ACL()` 展开
与上游 `console/acl` 逐位一致（覆盖矩阵第 168 条）；两条授权规则的**文案与状态码**
逐条对齐（第 169 / 170 / 171 / 172 条）；钱包账本端点的 `limit 1..100`、
`after` / `before` 时间窗、游标分页与上游 `server/console_account.go::GetWalletLedger`
同形。

**多租户语义变强**：上游是"一个进程一个游戏、一个控制台一套用户"；本项目是
"一个租户一张 `console_user` 表、控制台操作只作用在本租户内"（ECN-0001）。

**测试不外呼**：内购校验通过注入传输层进入测试，E2E 与单测都不打 Apple / Google
真实端点，因此这套测试**不产生任何厂商侧或 Cloudflare 侧账单**。

## 影响范围

- 受影响的 Req ID：REQ-0001-021（验收口径：核心操作可完成）、
  REQ-0001-022（验收口径：上游 `iap` 等价断言，含伪造收据被拒）、
  REQ-0001-023（验收口径收窄为两条：限流阈值可配 + 日志含请求 ID）。
- 受影响的计划：[v4-console-ops.md](../plan/v4-console-ops.md)（M9）的 DoD 1~11 直接对应本文。
- 受影响的代码：`src/domain/console/**`、`src/http/routes/console-*.ts`、
  `src/http/request-id.ts`、`src/durable/rate-limiter.ts`、`src/domain/iap/**`、
  `src/http/routes/iap.ts`、`migrations/0007_console.sql`、`wrangler.jsonc`。
- 受影响的测试：`tests/unit/console/`、`tests/unit/ops/`、
  `tests/integration/console/`、`tests/integration/iap/`、`tests/integration/ops/`、
  `tests/e2e/console.e2e.test.ts`、`tests/e2e/ops.e2e.test.ts`。

## 处置方式

- [x] PRD 已同步（REQ-0001-021 / 022 / 023 的偏差备注与验收口径）
- [x] vN 计划已同步（v4-console-ops.md 的 Scope / Risks）
- [x] 追溯矩阵已同步（ECN 索引与 M9 行）
- [x] 相关测试已同步（`tests/unit/console/`、`tests/integration/console/`、
  `tests/integration/iap/`、`tests/integration/ops/`）
