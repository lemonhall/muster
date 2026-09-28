# v1-foundation — 工程地基与一致性工装（M0）

## Goal

让"用 Cloudflare 重实现这套游戏后端"这件事具备**可运行、可测试、可追溯**的工程底座：本地 workerd 运行时能起、契约测试能跑（且红过）、E2E 走真实 HTTP 通道、上游测试清单与覆盖矩阵由脚本生成、文档卫生可自动检查。

## PRD Trace

- REQ-0001-001（项目骨架）
- REQ-0001-002（健康检查与根路径语义对齐）

## Scope

**做**

- TypeScript + workerd 工程链：`package.json`、`tsconfig.json`、`wrangler.jsonc`、vitest（runtime 内）配置、E2E 配置（真实进程 + HTTP）。
- 三条契约行为：`GET /` → 200；`GET /healthcheck` → 200 且 body 为 `{}`；未知路径 → 404 JSON 错误体。
- 上游测试清单脚本 + 覆盖矩阵脚本 + 文档卫生脚本。
- `npm` 脚本入口：`test` / `typecheck` / `e2e` / `conformance:inventory` / `conformance:matrix`。

**不做**

- 任何业务功能（认证、存储、WS、聊天都在 M1–M4）。
- Docker、外部数据库、CI 云配置（CI 在 v2 再引入）。
- 上游代码的任何复制（只扫描其测试清单，不搬运源码）。

## Acceptance

见 [v1-index.md](./v1-index.md) 的 M0 DoD 表（6 条 + 3 条反作弊）。

## Files

| 路径 | 作用 |
|---|---|
| `package.json` | 依赖与脚本入口 |
| `tsconfig.json` | 严格类型检查 |
| `wrangler.jsonc` | Worker 入口、兼容日期、D1/DO 绑定占位 |
| `vitest.config.ts` | runtime 内测试（workerd） |
| `vitest.e2e.config.ts` | E2E 配置（node 环境 + globalSetup 拉起本地 Worker） |
| `tests/e2e/global-setup.ts` | 启动/关闭本地 Worker 进程，等待就绪 |
| `tests/integration/healthcheck.test.ts` | 契约测试（runtime 内） |
| `tests/e2e/toolchain.e2e.test.ts` | E2E：经真实 HTTP 验证根路径与健康检查 |
| `src/index.ts` | Worker 入口（healthcheck / 根路径 / 404） |
| `src/env.ts` | 绑定类型定义（v1 逐步填充） |
| `scripts/upstream-inventory.mjs` | 生成上游测试清单 + 基线校验 |
| `scripts/conformance-matrix.mjs` | 生成覆盖矩阵，校验无理由豁免 |
| `scripts/doc_hygiene_check.py` | 文档卫生检查 |
| `docs/conformance/upstream-inventory.md` | 生成物：上游测试清单 |
| `docs/conformance/coverage-matrix.md` | 生成物：覆盖矩阵 |
| `docs/conformance/baseline.json` | 生成物：上游 commit SHA 与条目基线 |

## Steps

1. **红**：写 `tests/integration/healthcheck.test.ts`（断言根路径 200、healthcheck 200 + `{}`、未知路径 404），此时 `src/index.ts` 尚未实现对应行为。
2. **运行到红**：`npm test` → 预期失败（`GET /healthcheck` 返回 404，或模块不存在）。
3. **实现（绿）**：`src/index.ts` 按上游语义实现根路径、`/healthcheck`（protojson 的 `Empty` 即 `{}`）、统一 JSON 错误体。
4. **运行到绿**：`npm test` → 退出码 0。
5. **E2E 通道**：加 `tests/e2e/global-setup.ts` + `toolchain.e2e.test.ts`，`npm run e2e` 真起进程后经 HTTP 访问 → 退出码 0。
6. **一致性工装**：实现三个脚本，`npm run conformance:inventory`、`npm run conformance:matrix`、`python scripts/doc_hygiene_check.py --root .` 全部退出码 0。
7. **类型检查**：`npm run typecheck` 退出码 0。
8. **证据回填**：把红/绿输出粘贴进本文件 Evidence 段。

## Risks

| 风险 | 缓解 |
|---|---|
| `@cloudflare/vitest-pool-workers` 与 vitest 版本不匹配导致装不上 | 锁到官方支持的版本组合；装不上则改用 `unstable_startWorker` + 真实 HTTP 的单一通道，仍满足"无 Docker"约束 |
| 本机代理导致 npm 安装慢或失败 | 所有 npm 命令走 `127.0.0.1:7897`；失败则记录并在 v1-index 差异列表登记 |
| `wrangler dev` 在 E2E 中启动慢/端口占用 | 端口可配（默认 8788）、就绪轮询 `/healthcheck`、超时后 dump 子进程日志 |
| 上游测试清单脚本把 helper 函数误计为测试 | 只匹配 `^func Test`；条目数与上游 `func Test` 计数交叉校验 |

## Evidence

（执行时回填：红的输出、绿的输出、各脚本输出）
