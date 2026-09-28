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
| M3 | 实时协议骨架与在线状态（`/ws`、`Envelope`、presence） | ⏳ 未开始 |
| M4 | 频道与会话内聊天 | ⏳ 未开始 |

每个里程碑的 DoD、验证命令与证据见 [docs/plan/v1-index.md](docs/plan/v1-index.md)。

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

## 计划与进度

- 愿景：[docs/prd/VISION.md](docs/prd/VISION.md)
- 需求基线：[docs/prd/PRD-0001-muster-parity.md](docs/prd/PRD-0001-muster-parity.md)
- 版本计划索引：[docs/plan/v1-index.md](docs/plan/v1-index.md)

## 上游仓库位置

清单脚本默认读 `MUSTER_UPSTREAM_DIR` 环境变量，未设置时回退到 `../nakama`
（即与本仓库同级的本地检出）。这只用于**扫描测试清单**，不参与构建与运行。
