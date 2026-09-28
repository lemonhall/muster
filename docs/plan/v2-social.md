# v2-social — 社交：好友、群组、通知、Google 登录校验（M5）

## Goal

把"玩家之间的关系"补上：谁和谁是好友、谁在哪个群里、谁该收到哪条通知。
这三件事在上游是 `user_edge` / `groups` + `group_edge` / `notification` 三张表加一堆
状态机，在客户端眼里则是 17 条 REST 路径与 4 个枚举。M5 还要顺带关掉 v1 留下的
两处后置：私聊请求通知（ECN-0007 偏差 2）与群组频道准入（ECN-0007 偏差 4）。

社交登录这一块只搬**可离线验证**的那一半：Google ID token 的 aud/azp 规则与授权码
流程。其余 provider（Apple / Facebook / Steam / GameCenter）需要真实凭据与真实密钥交换，
在没有凭据的环境里唯一诚实的可观测行为是上游那句"未配置"错误，因此它们只做配置守卫，
见 [ECN-0009](../ecn/ECN-0009-google-id-token.md)。

## PRD Trace

- REQ-0001-011（好友 / 关注 / 拉黑）
- REQ-0001-012（群组：创建、加入、角色、踢人、封禁、列表）
- REQ-0001-013（通知与收件箱）
- REQ-0001-003（认证；本里程碑交付其 OAuth 分支的前半段：Google ID token 校验）

## Scope

**做**

- 好友：`GET/POST/DELETE /v2/friend`、`POST /v2/friend/block`、`GET /v2/friend/friends`。
  状态机 = 双向边：加 = 写 `INVITE_SENT` + `INVITE_RECEIVED`，回加 = 两边都变 `FRIEND`，
  删除 = 两边都删，拉黑 = 自己那条变 `BLOCKED` 且删掉对方那条。
- 群组：`/v2/group` 的列/建，`/v2/group/{id}` 的改/删，`/v2/group/{id}/{join,leave,add,kick,ban,promote,demote}`，
  `GET /v2/group/{id}/user`，`GET /v2/user/{id}/group`。
- 通知：`GET /v2/notification`、`DELETE /v2/notification`，以及由好友/群组/私聊事件产生的通知。
- Google：`POST /v2/account/authenticate/google`（ID token 或授权码）。
- 关闭 v1 的后置项：DM 请求通知、群组频道准入（`canAccessGroup` 接真表）。

**不做**

- Apple / Facebook / Steam / GameCenter 的真实凭据交换（只做"未配置"守卫）。
- Facebook / Steam 好友导入的真实 API 调用之外的**凭据获取**（导入逻辑本身实现，凭据由运营者配）。
- 管理台对社交数据的读写（M9）。

## Acceptance

见 [v2-index.md](./v2-index.md) 的 M5 DoD（11 条）。

## Files

| 路径 | 作用 |
|---|---|
| `migrations/0003_social.sql` | `user_edge` / `groups` / `group_edge` / `notifications` 四张表 |
| `src/domain/friends/{types,store,edges,validate,cursor,service,mutate}.ts` | 好友边：类型与状态枚举、读 SQL、写 SQL、目标解析、游标、列表、状态机与通知 |
| `src/domain/base64url.ts` | 各域共用的 base64url 编解码与游标长度上限 |
| `src/domain/groups/{types,ids,store,cursor,edges,listing,group-list-query,group-writes,membership-guards,membership,service,notify}.ts` | 群组与成员边（12 个文件：行形状与枚举、id 校验、读 SQL、游标、边写入、两种列表、目录过滤、群属性写入、成员守卫、角色状态机、生命周期、频道事件） |
| `src/domain/notifications/{codes,store,cursor,service,dm-request}.ts` | 通知的类别码、写入、列表、删除、私聊请求通知 |
| `src/durable/{channel-presence,channel-group-events}.ts` | 频道 presence 翻译与群事件（把 `channel-core.ts` 压回 300 行以内） |
| `src/domain/social/google/{jwt,verify,certs,profile,token,auth-code,authenticate,config}.ts` | RS256 验签（WebCrypto + JWKS 缓存）、aud/azp 规则、授权码流程、账号映射与运营者配置 |
| `src/http/routes/{friend,group,notification,authenticate-social}.ts` | REST 端点 |
| `src/wire/{friend,group,notification}.ts` | protojson 线格式 |
| `src/realtime/notifications.ts` + `src/durable/session-registry.ts` | 通知的实时帧与"按用户推送"的注册表入口 |
| `tests/integration/{friends,groups,notifications,social}/*.test.ts` | 搬运与契约测试 |
| `tests/e2e/social.e2e.test.ts` | 真实 HTTP 面的社交全流程 |

## Steps

1. **红**：写 `TestServer_ListFriendsOfFriends` 的 4 个子用例与 Google 三个用例的搬运版，`npm test` → 预期失败。
2. **绿**：落 `0003_social.sql` + 好友领域层 + Google 校验，跑到绿（DoD 1/2/3）。
3. **红→绿**：群组领域层与角色矩阵（DoD 4/5）。
4. **红→绿**：通知列表/删除与三类事件通知（DoD 6/7）。
5. **红→绿**：DM 请求通知与群组频道准入（DoD 8）。
6. **E2E（DoD 9）**：真实 HTTP 面的社交全流程。
7. **覆盖矩阵与文档回填（DoD 10/11）**：M5 段落转 `ported`，第二证据源补 `/v2/group`、`/v2/notification`。

## Risks

| 风险 | 缓解 |
|---|---|
| 好友边是双向写，D1 的 batch 不保证"两条边原子" | 用同一个 `batch()` 提交两条边的写法（D1 batch 本身就是事务），并对"只写了一半"的状态做幂等修复测试 |
| 私聊通知会给每个新加入者都发一次 | 上游用 `isNew` 挡重复；本项目在频道 DO 的 join 结果里带出"是否新成员"，只在为真时发 |
| 群组权限矩阵容易漏格 | 测试用 `for (const role of ...) for (const op of ...)` 的笛卡尔积逐格断言，而不是挑几个代表 |
| Google 证书刷新路径在无网环境不可测 | 验签所需的公钥由调用方注入（与上游 `client.googleCerts` 同构），刷新路径只测"没证书时报错" |
| 通知默认 `limit=1` 这种反直觉默认值被改掉 | 默认值写成常量并在测试里断言"不传 limit 只回 1 条" |

## Evidence

每个 DoD 一条，命令与输出都可复现。命令一律在本机 workerd / 本地 `wrangler dev --local`
上跑，不连任何 Cloudflare 账号资源。

### 红/绿证据（反作弊条款：DoD 1 与 DoD 3）

两条 DoD 的用例都要先红后绿。红证据的**复现方式**是：把 M5 的实现临时摘掉
（好友/群组/通知路由不注册、`checkGoogleToken` 直接抛"未实现"），跑同一批用例，
输出如下；随后恢复实现再跑同一批用例。这不是首次 TDD 的原始日志（首次红发生在写实现之前，
当时没有留档），而是**同一批用例在"实现缺失"状态下的红**——它的意义是证明这些用例真的
钉住了 M5 的行为，而不是跟着实现一起写出来的空断言。

```text
$ npx vitest run tests/integration/friends/friends-of-friends.test.ts \
    tests/integration/social/google-token.test.ts tests/integration/social/google-auth-code.test.ts \
    tests/integration/groups tests/integration/notifications
❯ tests/integration/friends/friends-of-friends.test.ts (4 tests | 4 failed)
❯ tests/integration/groups/{lifecycle,join,membership,roles,listing-groups,listing-members}.test.ts (全部失败)
❯ tests/integration/notifications/{list,delete}.test.ts (全部失败)
❯ tests/integration/social/google-token.test.ts (16 tests | 6 failed)
❯ tests/integration/social/google-auth-code.test.ts (3 tests | 1 failed)
AssertionError: expected 501 to be 200 // Object.is equality
AssertionError: expected 501 to be 404 // Object.is equality
GoogleTokenError: 【红证据临时改动】google id token 校验尚未实现
 Test Files  11 failed (11)
      Tests  51 failed | 12 passed (63)
```

```text
$ npx vitest run tests/integration/friends/friends-of-friends.test.ts tests/integration/social \
    tests/integration/groups tests/integration/notifications   # 实现恢复后
 Test Files  14 passed (14)
      Tests  79 passed (79)
```

真实 HTTP 面上的红证据（DoD 9）：把 `registerGroupRoutes` / `registerNotificationRoutes`
注释掉后单跑 `tests/e2e/social.e2e.test.ts`，三条用例全红在同一个原因上——群组与通知的
路由不存在，返回未实现。

```text
$ npx vitest run --config vitest.e2e.config.ts tests/e2e/social.e2e.test.ts
 ❯ tests/e2e/social.e2e.test.ts (3 tests | 3 failed)
AssertionError: expected 501 to be 200 // Object.is equality
 Test Files  1 failed (1)
      Tests  3 failed (3)
```

### 逐条 DoD

| DoD | 证据 | 命令与结果 |
|---:|---|---|
| 1 | `tests/integration/friends/friends-of-friends.test.ts`（4 条，用例头 `溯源: server/core_friend_test.go::TestServer_ListFriendsOfFriends`） | `npm test` → **54 files / 394 tests 全绿**；覆盖矩阵第 60 条 `ported` |
| 2 | `tests/integration/friends/{relations,delete-block,list}.test.ts`（加/回加/删/拉黑四条路径，含库内 `user_edge` 行断言与通知行断言） | 同上；`user_edge` 的双向两行、`state` 取值、`-2`/`-3`/`-9` 通知逐条断言 |
| 3 | `tests/integration/social/google-token.test.ts`（16 条）、`google-auth-code.test.ts`（3 条）、`google-certs.test.ts`、`google-authenticate.test.ts`、`google-endpoint.test.ts`；公钥由本机 RSA 私钥签名，证书源由调用方注入 | 同上；"畸形 JWT 不外发"用 `countingFetch` 的外部请求计数 = 0 判定；覆盖矩阵第 61/62/63 条 `ported` |
| 4 | `tests/integration/groups/{lifecycle,join}.test.ts`（重名 409 `Group name is in use.`、`edge_count=1`、开放群直接加入、私有群写 state=3 并给管理员发 `-5`、`max_count` 生效 → `Group is full.`） | 同上；断言读 `groups` / `group_edge` / `notifications` 三张表的行 |
| 5 | `tests/integration/groups/{roles,membership}.test.ts`（`for role × for op` 笛卡尔积逐格断言，含最后一个 superadmin 不能离开） | 同上；拒绝文案逐字对齐 `Group not found or permission denied.` |
| 6 | `tests/integration/notifications/{list,delete}.test.ts`（默认 `limit=1`、`create_time,id` 升序、空列表也给 `cacheable_cursor`、翻页不重不漏、删自己的） | 同上；`DELETE` 传别人的通知 id 是 0 行的成功空操作 |
| 7 | `tests/integration/channel/dm-request.test.ts`（关闭 ECN-0007 偏差 3） | 同上；"对方已在频道"分支不产生 `-1` |
| 8 | `tests/integration/channel/group-access.test.ts`（关闭 ECN-0007 偏差 4）：成员能进 `3.<group_id>..` 并收发消息，非成员被拒 | 同上；非成员在实时侧收到 `Group not found: Invalid channel target`（BAD_INPUT），REST 历史侧为 `Group not found.` |
| 9 | `tests/e2e/social.e2e.test.ts`（3 条：好友请求→通知→接受→互列好友；建群→第二人加入→两条群列表；通知删除的跨用户隔离） | `npm run e2e` → **7 files / 31 tests 全绿**（同一次运行 174s；M4 收尾是 6 files / 28 tests） |
| 10 | `npm run conformance:matrix` → `entries=263 ported=63 planned=200 exempt=0 unreasoned_exemptions=0 derived_citations=100`；M5 桶 `4 条目 / 4 ported / 0 planned`；第二证据源段出现 `apigrpc/apigrpc.swagger.json::/v2/group` 与 `::/v2/notification`（引用者 `tests/e2e/social.e2e.test.ts`） | 见命令输出 |
| 11 | `npm run docs:check` → `docs_hygiene: files=26 requirements=26 plans=4 links=96 inventory_numbers=15 problems=0`；ECN-0008（含偏差 1–14）、ECN-0009 在 PRD 与计划里都有引用 | 见命令输出 |
