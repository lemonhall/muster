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
| `src/domain/groups/{store,cursor,service,access}.ts` | 群组与成员边、游标、角色权限矩阵、频道准入 |
| `src/domain/notifications/{store,cursor,service}.ts` | 通知的写入、列表、删除、游标 |
| `src/domain/social/google/{jwt,verify,token}.ts` | RS256 验签、aud/azp 规则、授权码流程 |
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

见 [v2-index.md](./v2-index.md) 的追溯矩阵与本节后续回填（每个 DoD 一条）。
