# v1-identity-storage — 身份、账号与存储引擎（M1 + M2）

## Goal

打通"客户端拿到令牌 → 认证后可读写自己的数据"这条纵切：上游的鉴权/会话语义在这边成立，存储引擎的权限、版本与分页语义逐条对齐（存储是上游测试套件最厚的一块：`core_storage_test.go` 54 条 + `storage_index_test.go` 3 条，合计 57 条）。

## PRD Trace

- REQ-0001-003（认证方式与服务端密钥）
- REQ-0001-004（会话与令牌）
- REQ-0001-005（用户资料）
- REQ-0001-006（存储引擎）
- REQ-0001-007（存储索引）
- REQ-0001-026（多租户，见 [ECN-0001](../ecn/ECN-0001-multi-tenancy.md)）

## Scope

**做（M1）**

- **多租户**（先于其他一切）：`tenants` 表（server key 只存哈希）、所有业务表带 `tenant_id`、
  按租户派生令牌签名密钥（HKDF-SHA256）、租户解析（Basic server key 反查 / 令牌 `gid` claim）、
  开通 CLI `npm run tenant:create`。租户之间数据与令牌互不可见、互不可用。
- `Authorization: Basic base64("<server_key>:")` 服务端密钥鉴权；缺头/错键 → 401。
- 认证端点：`/v2/account/authenticate/device`、`/email`、`/custom`（含 `create` 语义）。
- 令牌：access token（JWT）、refresh token、过期、`/v2/session/logout`、`/v2/session/refresh`。
- 资料：`/v2/account`（GET/PUT）、`/v2/user`（按 `ids` / `usernames` 多值 query 批量查）；字段含 `username`、`display_name`、`avatar_url`、`lang_tag`、`location`、`timezone`、`metadata`。
- 存储：D1 作为账号/资料权威库（`tenants`、`users`、`user_identity`、`sessions` 表），全部按 `tenant_id` 分区。

**做（M2）**

- `/v2/storage`（PUT 写，支持 `version` 乐观锁；POST 读，单/多 owner、多集合）、`/v2/storage/delete`、`/v2/storage/{collection}` 与 `/v2/storage/{collection}/{userId}`（列表 + 游标分页）——路径以 `apigrpc/apigrpc.swagger.json` 为准。
- 权限位：`permission_read`（0/1/2 = owner-only/public-read/…）、`permission_write`；越权返回与上游一致的错误码。
- 存储索引：按集合内字段建立可查询索引，支持 AND/OR 与排序 + 游标。
- 权威数据在 D1；`version` 递增通过 `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE version = ?` 在原子批内完成。

**不做**

- 社交登录（Google/Apple/Facebook/Steam）——v2（REQ-0001-003 的 OAuth 分支明确后置）。
- 多设备会话列表、管理台强制登出（M9）。
- 存储的 group-scope 权限（依赖群组，M5）。

## Acceptance

见 [v1-index.md](./v1-index.md) 的 M1 DoD（7 条）与 M2 DoD（6 条）。

## Files

| 路径 | 作用 |
|---|---|
| `migrations/0001_identity.sql` | 租户、用户、身份、会话的 D1 schema |
| `src/domain/tenancy/store.ts` | 租户登记的读写（按 server key 哈希反查） |
| `src/domain/identity/token.ts` | 按租户派生签名密钥（HKDF-SHA256）、JWT 签发/校验、`gid` claim |
| `src/domain/identity/password.ts` | 密码哈希（PBKDF2-SHA256，见 [ECN-0002](../ecn/ECN-0002-password-hash.md)） |
| `src/domain/identity/store.ts` | `users` / `user_identity` / `sessions` 的租户内读写 |
| `src/domain/identity/service.ts` | 认证、会话、资料、用户查询的领域逻辑（校验顺序与错误文案的落点） |
| `src/http/auth.ts` | Basic（server key → 租户）/ Bearer（`gid` claim → 租户）解析 |
| `src/http/router.ts` | 方法感知路由 + 上游对账面 + 按路由类别鉴权（对应上游 `securityInterceptorFunc`） |
| `src/http/errors.ts` | `ApiError` 与 `google.rpc.Code` 构造子（全项目唯一失败出口） |
| `src/http/grpc.ts` | gRPC→HTTP 状态码映射、错误体形状、401 挑战头 |
| `src/http/routes/identity.ts` | 认证 / 会话 / 账号 / 用户查询端点 |
| `src/wire/identity.ts` | protojson 线格式（snake_case、省略零值、RFC3339） |
| `src/http/endpoints.generated.ts` | 上游 91 个 REST 操作的对账表（脚本生成） |
| `scripts/tenant.mjs` | 租户开通 CLI（生成本地/远端记录，一次性打印 server key） |
| `src/http/routes/storage.ts` | 存储读写、列表、删除（M2） |
| `src/domain/storage/objects.ts` | 对象 CRUD、权限判定、版本语义 |
| `src/domain/storage/cursor.ts` | 游标编码/解码（不透明、可校验） |
| `src/domain/storage/index.ts` | 存储索引查询编译 |
| `tests/helpers/tenants.ts` | 测试工装：建租户、Basic/Bearer 头、请求辅助 |
| `tests/integration/identity.test.ts` | M1 契约测试（53 条：认证 / 令牌 / 账号 / 查询 / 登出） |
| `tests/integration/tenancy.test.ts` | 多租户隔离（7 条） |
| `tests/unit/tenancy_keys.test.ts` | 每租户密钥派生（8 条） |
| `tests/integration/storage/*.test.ts` | 存储语义与权限矩阵测试（M2） |
| `tests/e2e/identity.e2e.test.ts` | 端到端：登录 → 读资料 → 改名 → 读回 → 刷新 → 登出 + 跨租户隔离 |
| `tests/e2e/storage.e2e.test.ts` | 端到端：写存储 → 读回 → 分页遍历（M2） |

## Steps

1. **红**：写 M1 契约测试（设备登录 200、缺密钥 401、邮箱冲突 409、过期令牌 401、登出后失效），`npm test` → 预期 401/404/未实现失败。
2. **绿**：实现 D1 schema + 账号/令牌域逻辑 + 三个认证端点，跑到绿。
3. **E2E（M1）**：真实 HTTP 完成"登录 → 读资料 → 改名 → 读回"，`npm run e2e` 退出码 0。
4. **红**：写 M2 测试（CRUD/version 冲突/权限矩阵/批量原子性/游标 1 万条）。
5. **绿**：实现存储域逻辑 + 索引查询，跑到绿。
6. **E2E（M2）**：10,000 条对象分页遍历断言无重复无遗漏。
7. **覆盖矩阵回填**：把 `core_storage_test.go` 54 + `storage_index_test.go` 3 的每条状态从 `planned` 推进到 `ported` 或 `exempt(理由)`。

## Risks

| 风险 | 缓解 |
|---|---|
| D1 无交互式多语句事务，版本递增与唯一性竞态 | 用 `batch()` 原子批 + `WHERE version = ?` 条件更新；冲突即返回上游一致的错误 |
| 游标语义与上游不一致（上游用多种游标编码） | 先按上游文档化的行为写测试，再实现；不确定处以集成断言为准并记录 ECN |
| 密码/密钥哈希与上游不同导致兼容问题 | 已定案：[ECN-0002](../ecn/ECN-0002-password-hash.md)（PBKDF2-SHA256 100k 代替 bcrypt；workerd 无 bcrypt 原语；对外形状零变化） |
| 上游 `api_test.go` 的断言细节不足 | 以 `api.proto` + swagger 的返回码定义补齐，并把推导过程写进覆盖矩阵的理由列 |

## Evidence

### M1-A 测试全绿（单元 + 集成，跑在本地 workerd）

```
> muster@0.1.0 test
> vitest run --reporter=verbose

 ✓ tests/integration/healthcheck.test.ts (3)
 ✓ tests/integration/identity.test.ts (53)
 ✓ tests/integration/tenancy.test.ts (7)
 ✓ tests/unit/grpc_status.test.ts (18)
 ✓ tests/unit/runtime.test.ts (1)
 ✓ tests/unit/tenancy_keys.test.ts (8)

 Test Files  6 passed (6)
      Tests  90 passed (90)
```

`tests/unit/runtime.test.ts` 是 M0 的反作弊门禁：它断言 `navigator.userAgent === "Cloudflare-Workers"`，
所以上面 90 条**确实跑在 workerd 里**，不是被回退到 node 环境跑出来的绿。

### M1-B E2E（真实 HTTP：真实 `wrangler dev --local` 进程）

```
> muster@0.1.0 e2e
> vitest run --config vitest.e2e.config.ts

[e2e] muster 本地 Worker 已就绪：http://127.0.0.1:8788 (pid=4424)

 Test Files  2 passed (2)
      Tests  18 passed (18)
```

其中 `tests/e2e/identity.e2e.test.ts` 14 条：设备登录 → 带令牌读资料 → 改显示名 → 读回 →
刷新换发 → 登出后令牌失效 → 用户名/ID 批量查询 → 未实现路径 501 语义；
以及**多租户隔离** 3 条：同一 device id 在两租户下得到两个不同账号、B 租户令牌查不到 A 租户的用户、
同名用户在两租户下各自存在且互不可见。

反证（E2E 不是进程内直调）：把目标指向一个没人监听的端口，整组必须变红——

```
> $env:MUSTER_E2E_TARGET='http://127.0.0.1:8799'; npm run e2e

 Test Files  2 failed (2)
      Tests  18 failed (18)
  → 每条都是 ECONNREFUSED 127.0.0.1:8799，退出码 1
```

### M1-C 只有本地资源，零 Cloudflare 账单

E2E 的每一次 wrangler 调用都带 `--local`（迁移与租户写入见 `tests/e2e/global-setup.ts`），
运行数据落在仓库内 `.wrangler/state`；主密钥由 `--var SESSION_ENCRYPTION_KEY:...` 注入测试值。
因此本套测试不需要 `wrangler login`、不创建任何远端 D1/KV/DO，也不产生费用。

### M1-D 上游语义核对（逐条读源码，不是猜）

| 结论 | 上游来源 |
|---|---|
| 认证/刷新类端点走 Basic server key，其余走 Bearer；`/healthcheck` 硬豁免 | `server/api.go::securityInterceptorFunc` |
| 401 补 `WWW-Authenticate: Bearer realm="..."`，且不夹带原始错误消息 | `server/api.go::wwwAuthenticateFixWriter`、`server/api_test.go::TestWWWAuthenticateHeaderOnUnauthenticated`（realm 取值的偏差见 [ECN-0003](../ecn/ECN-0003-www-authenticate-realm.md)） |
| 请求体形状是顶层 `{"id":...}` 而非 `{"account":{...}}`（grpc-gateway `body: "account"` 语义） | `apigrpc/apigrpc.swagger.json` |
| 用户查询路径是 `GET /v2/user`，query 为 `ids`/`usernames`/`facebookIds`（`collectionFormat: multi`） | `apigrpc/apigrpc.swagger.json` |
| 校验顺序：设备/自定义先 ID 后用户名；邮箱先字符集→格式→长度→密码→用户名 | `server/core_authenticate.go`、`server/api_authenticate.go` |
| 两个令牌都为空时 `/v2/session/logout` 吊销该用户全部会话（不报错） | `server/api_session.go::SessionLogout` |
| `GET /v2/account` 显式清空 `disable_time`，不对外暴露封禁时间 | `server/api_account.go::GetAccount` |

### M1-E 多租户（ECN-0001）的可执行证据

- 数据：所有业务表带 `tenant_id`，用户名/邮箱的唯一约束是 `UNIQUE (tenant_id, ...)`——
  "每个游戏内唯一"这个上游语义被显式化成库结构，见 `migrations/0001_identity.sql`。
- 令牌：签名密钥 = `HKDF-SHA256(master, salt=tenant_id, info="muster/session"|"muster/refresh")`，
  见 `tests/unit/tenancy_keys.test.ts`（8 条，含"换租户即验签失败"）。
- 越权：`tests/integration/tenancy.test.ts`（7 条）+ E2E 3 条。
