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

执行环境：2026-09-28 21:35（CST），Windows 11 + PowerShell 7，Node v24.12.0，npm 11.11.1，**本机无 Docker、无外部数据库**。上游基线 commit `e920249a3465bea4b8ea2968020c488201b61a8e`。

### A. 反证红：契约测试不是空转（`npm test` → 红）

探针：临时从 `src/index.ts` 摘掉 `GET /` 与 `GET /healthcheck` 两条注册，再跑集成测试（探针跑完即删除，`src/index.ts` 已恢复原状，`git diff` 中不含该文件）。

```
$ npx vitest run tests/integration/healthcheck.test.ts --reporter=verbose

 × tests/integration/healthcheck.test.ts > M0 契约: 根路径与健康检查 > test_get_root_returns_200 15ms
   → expected 404 to be 200 // Object.is equality
 × tests/integration/healthcheck.test.ts > M0 契约: 根路径与健康检查 > test_get_healthcheck_returns_200_with_empty_json_object 5ms
   → expected 404 to be 200 // Object.is equality
 ✓ tests/integration/healthcheck.test.ts > M0 契约: 根路径与健康检查 > test_get_unknown_path_returns_404_with_grpc_status_body 4ms

 Test Files  1 failed (1)
      Tests  2 failed | 1 passed (3)
EXIT=1
```

失败是**具名**的（用例名 + 期望值 vs 实际值），且只有被摘掉实现的那两条变红、404 那条保持绿——说明断言指向具体行为，不是笼统报错。

### B. 绿：单元 + 集成，运行在真实 workerd（`npm test` → 绿）

```
$ npm test

 ✓ 19 × tests/unit（18 条 gRPC code → HTTP 状态逐条映射 + 1 条 workerd 运行时身份）
 ✓  3 × tests/integration/healthcheck.test.ts（根路径 / healthcheck / 未知路径）

 Test Files  3 passed (3)
      Tests  22 passed (22)
EXIT=0
```

其中 `tests/unit/runtime.test.ts` 断言 `navigator.userAgent === "Cloudflare-Workers"`——这是反作弊条款 2（"测试必须真跑在 workerd 里"）的永久化门禁：哪天依赖升级把池配置打回 node 环境，这条会立刻变红，而不是等人记得。

### C. 绿：类型检查（`npm run typecheck` → 绿）

```
$ npm run typecheck
> tsc --noEmit
EXIT=0
```

### D. 绿：E2E 走真实 HTTP（`npm run e2e` → 绿）

```
$ npm run e2e

[e2e] muster 本地 Worker 已就绪：http://127.0.0.1:8788 (pid=39972)

 Test Files  1 passed (1)
      Tests  4 passed (4)
EXIT=0
```

`pid=39972` 是 global-setup 真起出来的 `wrangler dev` 子进程（teardown 用 `taskkill /T /F` 连 workerd 一起收掉）。

### E. 反证：E2E 不是进程内直调处理器函数

```
$ $env:MUSTER_E2E_TARGET='http://127.0.0.1:8799'; npm run e2e

 TypeError: fetch failed
 Caused by: Error: connect ECONNREFUSED 127.0.0.1:8799

 Test Files  1 failed (1)
      Tests  4 failed (4)
EXIT=1
```

同一个测试文件、同一份代码，只把目标地址换成一个没人监听的端口就整片变红——如果 E2E 是 import 处理器函数做进程内调用，这不可能发生。这是"M0 的 E2E 确实走了网络"的直接证据。

### F. 一致性工装（全部退出码 0）

```
$ npm run conformance:inventory
upstream_files=40 upstream_tests=263 upstream_subtest_calls=35 upstream_commit=e920249a3465bea4b8ea2968020c488201b61a8e mode=verify

$ npm run conformance:matrix
entries=263 ported=0 planned=263 exempt=0 unreasoned_exemptions=0 derived_citations=5

$ npm run docs:check
docs_hygiene: files=9 requirements=25 plans=3 lines=1366 links=17 inventory_numbers=4 problems=0
```

`mode=verify` 表示本次是**对账**（拿工作区实际清单比对 `baseline.json`），不是重新生成——上游测试数一旦漂移，脚本以非 0 退出。

反证（手工编辑必须被拦）：把 `coverage-matrix.md` 里的一个测试名改掉一个字符后重跑：

```
$ npm run conformance:matrix
docs/conformance/coverage-matrix.md 缺少完整性标记（疑似被手工编辑）。
请删除该文件后重新运行本脚本重新生成，不要手工修补。
EXIT=1
```

删掉该文件重新生成后，`git status` 干净 —— 说明生成物是**确定性**的，且完整性标记能识别手工修补（同一天在 `doc_hygiene_check.py` 上也做过同类反证：把 `core_storage_test.go` 的条数改成 58，脚本以退出码 1 报 `与基线（54）不一致`）。

### G. M0 边界内的未覆盖项（已知且有意）

| 项 | 状态 | 说明 |
|---|---|---|
| Cloudflare 线上部署验收 | 未做 | 本机无 Docker、也没有现成 CF 账号资源；M0 按"本地 workerd 验证"设计，线上验收留给后续版本 |
| 覆盖矩阵 `ported=0` | 预期 | M0 只立地基，不搬业务测试；`planned=263` 就是全部待搬清单 |
| CI 云门禁 | 未做 | 按计划 CI 在 v2 引入，M0 的等价物是"每次改动手工跑这套命令" |
