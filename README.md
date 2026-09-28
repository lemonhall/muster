# Muster

Cloudflare-native 多人游戏后端。目标是把一套成熟开源游戏后端的**对外可观测行为**
（REST 语义、WebSocket 二进制协议、错误码、权限与分页语义）在 Cloudflare 原语上
重新实现一遍，而不是把原项目搬过来跑。

> 本项目是**独立实现**。它不包含任何上游源码，命名、包名、域名、文案一律不沿用上游名称。
> 上游仅作为**行为契约来源**：我们读它的测试与协议定义，把可观测行为重写成
> 在 workerd 上跑的测试。详见 [docs/prd/VISION.md](docs/prd/VISION.md) 与
> [NOTICE](NOTICE)。

## 技术选型（ADR-0001）

核心运行时 **TypeScript on workerd**，运行时扩展层同时接受 **TypeScript 与 Python**。
完整论证见 [docs/prd/PRD-0001-muster-parity.md](docs/prd/PRD-0001-muster-parity.md) §3。

一句话理由：长连接（Durable Object WebSocket 休眠）、proto 编解码工具链、
本地真实 workerd 测试运行时，这三件事决定了核心必须在 JS 侧；而扩展层不是热路径，
Python 完全够用。

## 环境要求

- Node.js ≥ 20（本机 24.x）、npm ≥ 10
- **不需要 Docker**，不需要本地数据库
- 中国大陆环境需要代理时才配 `HTTP_PROXY` / `HTTPS_PROXY`（本项目只用于拉依赖）

## 多租户：一个账号运营多个游戏

**租户（tenant）= 一个游戏。** 同一个部署（一个 Cloudflare 账号）可以并行运营任意多个游戏，
彼此的数据与令牌完全隔离：

- 每张业务表都带 `tenant_id`，用户名/邮箱的唯一性作用域是**租户内**（`UNIQUE (tenant_id, ...)`）；
- 租户由 `Authorization: Basic base64(<server_key>:)` 解析（认证类端点），
  或由访问令牌里的租户声明反过来解析（其余端点）；
- 每个租户的令牌签名密钥由主密钥派生（`HKDF-SHA256(master, salt=tenant_id, ...)`），
  所以 A 游戏的令牌在 B 游戏下必然验签失败——跨租户串号在密码学层就不可能；
- 没有"默认租户"这种隐式回退：解析不到租户就是 401。

开通一个租户（默认只打印 SQL，不会碰任何数据库）：

```powershell
npm run tenant:create -- --name "My Game"            # 打印 SQL 与一次性 server key
npm run tenant:create -- --name "My Game" --apply    # 写本地 D1（不产生账单）
npm run tenant:list -- --apply                        # 列出本地已开通的租户
```

写成线上需要显式加 `--remote --apply`（会真的产生资源与费用，命令自己会提示）。
设计论证见 [ECN-0001](docs/ecn/ECN-0001-multi-tenancy.md)。

## 进度

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 工程地基与一致性工装（workerd 测试链、上游清单、覆盖矩阵、文档卫生） | 🟢 完成 |
| M1 | 身份与账号：多租户、设备/邮箱/自定义认证、令牌与会话、资料读写 | 🟢 完成 |
| M2 | 存储引擎：对象 CRUD、权限、version 乐观锁、游标分页、存储索引 | 🟢 完成 |
| M3 | 实时协议骨架与在线状态（`/ws`、`Envelope`、presence） | 🟢 完成 |
| M4 | 频道与会话内聊天 | 🟢 完成 |
| M5 | 社交：好友、群组、通知、Google ID token 校验 | 🟢 完成 |
| M6 | 经济与竞技：钱包与账本、排行榜、锦标赛 | 🟢 完成 |
| M7 | 匹配与对局：票据池、查询表达式、match 句柄、超时 | 🟢 完成 |
| M8 | 派对与运行时扩展：派对状态机与实时面、租户模块宿主、`nk` 工具/数据/群组面 | 🟢 完成 |
| M9 | 管理台与运维面：控制台用户与 ACL、钱包账本端点、运行时创建面与权威写分、请求 ID 关联 | 🟡 进行中（11 条 DoD 已交付 8 条） |

M9 已交付的 8 条 DoD 与剩余 3 条（限流、内购校验、矩阵与文档收尾）逐条列在
[v4-console-ops.md](docs/plan/v4-console-ops.md) 的「进度」一节，含每条对应的提交号。

下一次接着做的三件事（细节与反作弊条款都在 v4 计划里）：

- **限流**：`src/durable/rate-limiter.ts`（每租户一个 DO，窗口计数只活在内存里）＋
  `wrangler.jsonc` 的 `RATE_LIMITER` 绑定与迁移项；超限 429 + `retry-after`，按租户隔离。
- **内购**：`src/domain/iap/{types,apple,service}.ts` ＋ `src/http/routes/iap.ts`；
  Apple 走 `verifyReceipt`，厂商调用走注入的传输层，测试不碰 Apple 端点。
- **收尾**：M9 段的 `planned` 清零、Evidence 回填、`docs/reviews/v4-M9.md`、
  `docs/plan/v2-index.md` 的追溯行，最后四个门禁一起跑。

门禁数字（全部跑在本机 workerd 与本地 `wrangler dev --local` 上，测试不外呼任何
Cloudflare 远端资源，因此不产生账单）：

- `npm run typecheck`：0 错（`761ff4d` 上复跑确认）；
- `npm test`：109 个测试文件、813 条断言全绿（M9 第 4 次提交点，此后只有文档改动）；
- `npm run e2e`：M8 收尾时的数字是 11 个文件、43 条；M9 的 E2E 还没重跑，
  与 DoD 9/10 一起放在收尾那一轮。

每个里程碑的 DoD、验证命令与证据：[v1-index.md](docs/plan/v1-index.md)（M0–M4）、
[v2-index.md](docs/plan/v2-index.md)（M5–M9 的追溯矩阵）、
[v3-party-runtime.md](docs/plan/v3-party-runtime.md)（M8）、
[v4-console-ops.md](docs/plan/v4-console-ops.md)（M9）。

## 常用命令

```powershell
npm install

npm test                 # 单元 + 集成测试，跑在真实 workerd 里
npm run typecheck        # tsc --noEmit
npm run e2e              # 起真实 Worker 进程，经 HTTP 打一遍
npm run dev              # 本地开发服务器

npm run conformance:inventory   # 生成上游测试清单（需本地检出上游仓库）
npm run conformance:matrix      # 生成覆盖矩阵 / 校验无理由豁免
npm run docs:check              # 文档卫生检查
```

## 工程准绳

**以上游测试套件为可执行规格**，分三层对齐：

1. **清单化** — `scripts/upstream-inventory.mjs` 扫描上游仓库，列出全部 `func Test*`
   并记录上游 commit SHA；上游漂移时必须显式 `--update` 才能通过。
2. **逐条搬运** — 我们的每条测试带 `溯源:` 注释指向它对齐的上游用例，且**必须先红后绿**。
3. **覆盖审计** — `docs/conformance/coverage-matrix.md` 列出每条上游测试的去向，
   状态只能是 `ported` / `planned` / `exempt(理由)`；无理由豁免直接失败。

细节与红绿证据要求见 [docs/prd/PRD-0001-muster-parity.md](docs/prd/PRD-0001-muster-parity.md) §2。

### 文件体量：单文件 ≤300 行

源码、测试、脚本、配置单个文件控制在 300 行以内；超了就按职责拆成兄弟文件
（先例：`tests/integration/identity/` 按主题拆 5 个文件，`tests/e2e/` 把设备认证与多租户
拆成 `identity.e2e.test.ts` / `tenancy.e2e.test.ts`，共用工装落在 `http-helpers.ts`）。
拆的是职责，不是删测试或删注释。

长文档同样拆：一个里程碑一份记录，别把整条链路堆进一个 md
（先例：里程碑 Review 记录从 `docs/plan/v1-index.md` 拆到 `docs/reviews/v1-M*.md`，
索引只留一张指针表）。

以下文件**整体豁免**（都是"拆了就废掉"的整块）：

| 文件 | 为什么是整块 |
|---|---|
| `docs/conformance/upstream-inventory.md` | 脚本生成的清单，价值在"每条都在表里、总数对得上" |
| `docs/conformance/coverage-matrix.md` | 脚本生成的矩阵，逐条去向与总数必须同表自洽 |
| `docs/conformance/baseline.json` | 脚本生成的机器基线（JSON 不能写注释），漂移检测的唯一锚点 |
| `package-lock.json` | npm 自己维护的 lockfile |
| `worker-configuration.d.ts` | `wrangler types` 生成的绑定类型 |

## 计划与进度

- 愿景：[docs/prd/VISION.md](docs/prd/VISION.md)
- 需求基线：[docs/prd/PRD-0001-muster-parity.md](docs/prd/PRD-0001-muster-parity.md)
- 版本计划索引：[docs/plan/v1-index.md](docs/plan/v1-index.md)

## 上游仓库位置

清单脚本默认读 `MUSTER_UPSTREAM_DIR` 环境变量，未设置时回退到 `../nakama`
（即与本仓库同级的本地检出）。这只用于**扫描测试清单**，不参与构建与运行。
