# v1-identity-storage — 身份、账号与存储引擎（M1 + M2）

## Goal

打通"客户端拿到令牌 → 认证后可读写自己的数据"这条纵切：上游的鉴权/会话语义在这边成立，存储引擎的权限、版本与分页语义逐条对齐（存储是上游测试套件最厚的一块，58 条）。

## PRD Trace

- REQ-0001-003（认证方式与服务端密钥）
- REQ-0001-004（会话与令牌）
- REQ-0001-005（用户资料）
- REQ-0001-006（存储引擎）
- REQ-0001-007（存储索引）

## Scope

**做（M1）**

- `Authorization: Basic base64("<server_key>:")` 服务端密钥鉴权；缺头/错键 → 401。
- 认证端点：`/v2/account/authenticate/device`、`/email`、`/custom`（含 `create` 语义）。
- 令牌：access token（JWT）、refresh token、过期、`/v2/session/logout`、`/v2/session/refresh`。
- 资料：`/v2/account`（GET/PUT）、`/v2/users`、`/v2/users/{id}`；字段含 `username`、`display_name`、`avatar_url`、`lang_tag`、`location`、`timezone`、`metadata`。
- 存储：D1 作为账号/资料权威库（`users`、`accounts`、`sessions` 表）。

**做（M2）**

- `/v2/storage`（写，支持 `version` 乐观锁）、`/v2/storage/read`（读，单/多 owner、多集合）、`/v2/storage/delete`、`/v2/storage/list`（游标分页）。
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
| `src/routes/account.ts` | 认证与账号端点 |
| `src/routes/session.ts` | 令牌刷新/登出 |
| `src/routes/storage.ts` | 存储读写、列表、删除 |
| `src/domain/identity/token.ts` | JWT 签发/校验、刷新令牌 |
| `src/domain/identity/account.ts` | 账号创建、资料读写、用户名唯一性 |
| `src/domain/storage/objects.ts` | 对象 CRUD、权限判定、版本语义 |
| `src/domain/storage/cursor.ts` | 游标编码/解码（不透明、可校验） |
| `src/domain/storage/index.ts` | 存储索引查询编译 |
| `migrations/0001_init.sql` | D1 schema |
| `tests/integration/auth/*.test.ts` | 认证与令牌契约测试 |
| `tests/integration/storage/*.test.ts` | 存储语义与权限矩阵测试 |
| `tests/e2e/auth-storage.e2e.test.ts` | 端到端：登录 → 读资料 → 改名 → 写存储 → 读回 → 分页遍历 |

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
| 密码/密钥哈希与上游不同导致兼容问题 | 邮箱认证的密码哈希只影响我们自己的库（客户端只发明文），按标准实现并在 PRD 记 ECN |
| 上游 `api_test.go` 的断言细节不足 | 以 `api.proto` + swagger 的返回码定义补齐，并把推导过程写进覆盖矩阵的理由列 |

## Evidence

（执行时回填）
