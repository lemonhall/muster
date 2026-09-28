# ECN-0001: 多租户（一个 Cloudflare 账号运营多个游戏）

## 基本信息

- **ECN 编号**：ECN-0001
- **关联 PRD**：PRD-0001
- **关联 Req ID**：新增 REQ-0001-026
- **发现阶段**：v1-identity-storage（M1）编码开始之前
- **日期**：2026-09-28

## 变更原因

柠檬叔明确要求：**同一个 Cloudflare 账号上，这套后端要能同时运营多个在线游戏**（多租户）。

原 PRD 是按「一套部署服务一个游戏」设计的（与上游参考实现一致：全局唯一的 server key、
全局唯一的用户名、没有租户维度）。如果按原设计把 M1 写完再改，等于把租户维度从数据模型、
令牌、Durable Object 命名一路补进去——那是返工，不是配置。

因此必须在 M1 落代码之前把租户维度设计进去。

## 变更内容

### 原设计

- 一个部署 = 一个游戏；`server_key` 全局唯一（对应上游 `socket.server_key`）。
- 用户、身份、会话表没有租户列；用户名在整库唯一。
- 会话令牌只绑定 `uid`，不绑定「哪个游戏」。

### 新设计

**租户（tenant）= 一个游戏**。同一部署内支持任意多个租户，彼此数据与令牌完全隔离。

1. **租户登记**：`tenants` 表
   - `id`（UUIDv4 大写，作为租户标识）
   - `name`（人类可读名，仅管理面使用）
   - `server_key_hash`（server key 的 SHA-256；**明文不落库**，创建时一次性打印）
   - `create_time` / `disable_time`
2. **数据隔离**：M1 起所有业务表带 `tenant_id`，并按 `(tenant_id, ...)` 建索引与唯一约束。
   - 用户名的唯一性作用域从「整库」变成「租户内」——这正是上游「每个游戏内用户名唯一」的语义。
   - 存储引擎（M2）、频道与对局（M3/M4）同样按 `tenant_id` 分区。
3. **租户解析（不改客户端 SDK）**：
   - 认证类端点：`Authorization: Basic base64(<server_key>:)` → 用 `sha256(key)` 反查租户；未知或已禁用 → 401 `{"code":16,"message":"Server key invalid"}`。
   - 已认证端点：Bearer 令牌里带 `gid`（game/tenant id）claim → 直接得到租户，不再需要反查。
4. **密钥派生**：每个租户的令牌签名密钥 = `HKDF-SHA256(master_secret, salt=tenant_id, info="muster/session")`。
   - 主密钥只有一个（`SESSION_ENCRYPTION_KEY`，走 secret，不进仓库）。
   - 于是 A 游戏的令牌在 B 游戏的签名校验下必然失败：跨租户串号在密码学层就不可能。
5. **Durable Object 命名（M3/M4）**：实例名统一 `<tenant_id>:<逻辑 id>`，
   保证同名频道或对局在不同租户下互不碰撞。
6. **对象存储（M2 起）**：R2 key 前缀 `<tenant_id>/`。
7. **租户开通**：v1 用 CLI（`npm run tenant:create`）写本地 D1 记录并一次性打印 server key；
   线上用同一命令的远端模式。管理台（REQ-0001-021）在 v4 把它变成界面。

### 明确不做（v1）

- 不做跨租户的全局账号（一个账号玩多个游戏）——上游也没有这个概念，且会破坏隔离假设。
- 不做按租户的独立数据库（D1 per tenant）：先用 `tenant_id` 分区，量级到了再谈物理拆分。
- 不做租户级配额与计费（归 REQ-0001-025 成本模型与 REQ-0001-023 运维面）。

## 影响范围

- 受影响的 Req ID：新增 REQ-0001-026；REQ-0001-003/004/005 的验收口径全部追加「在租户内成立」。
- 受影响的 vN 计划：`v1-index.md`（M1 DoD 增加一条）、`v1-identity-storage.md`（Scope/Files/Steps/风险）。
- 受影响的测试：M1 契约测试新增「跨租户隔离」一组（同用户名在两个租户下可共存；A 租户令牌在 B 租户被拒；错误 server key 返回 401）。
- 受影响的代码文件：`migrations/0001_identity.sql`、`src/domain/tenancy/*`、`src/domain/identity/*`、`src/http/auth.ts`、`src/index.ts`、`scripts/tenant.mjs`。
- 不受影响：上游对齐口径本身。租户维度是**本项目在协议之外自带的能力**，不改变任何上游端点的请求响应形状，上游测试的搬运不受影响。

## 处置方式

- [x] PRD 已同步更新（新增 REQ-0001-026、§6 约束、§7 里程碑归属）
- [x] vN 计划已同步更新（v1-index M1 DoD、v1-identity-storage）
- [x] 追溯矩阵已同步更新（REQ-0001-026 行）
- [x] 相关测试已同步更新（M1 多租户隔离用例）
