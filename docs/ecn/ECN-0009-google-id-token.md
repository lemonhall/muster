# ECN-0009: Google ID token 用 WebCrypto 验 RS256，证书来自 JWKS 端点

## 基本信息

- **ECN 编号**：ECN-0009
- **关联 PRD**：PRD-0001
- **关联 Req ID**：REQ-0001-003（认证的 OAuth 分支）
- **发现阶段**：v2-social（M5）编码中
- **日期**：2026-09-29

## 变更原因

上游的 Google 登录是 `social/social.go` 里的一个 `Client`，它同时承担两件事：

1. **ID token 校验**（`CheckGoogleToken`）：证书从 `https://www.googleapis.com/oauth2/v1/certs`
   取回一张 `kid → PEM(X.509)` 的表，逐个 `x509.ParseCertificate` 取出 RSA 公钥，
   再对 token 逐个公钥试 `jwt.Parse`（`WithExpirationRequired()` +
   `WithValidMethods(["RS256"])`），并在 keyfunc 里校验 `iss` 与（配置了 client id 时的）
   `aud` / `azp`；
2. **授权码换取**（`exchangeGoogleAuthCode` → `oauth2.Config.Exchange`，再
   `GET https://www.googleapis.com/games/v1/players/me?access_token=…`），
   只在"这个值根本不是 JWT 形状"时才会走（`strings.Count(idToken, ".") == 2` 是硬闸门）。

证书缓存本身带状态：`googleCerts` + `googleCertsRefreshAt`，刷新时刻取
"最早到期证书的 `NotAfter` 减 1 小时"，刷新失败直接报错（不清空旧证书）。

Cloudflare Workers 上的问题是**缺 X.509 解析**：标准库没有 `parseCertificate`，
而 WebCrypto 的 `crypto.subtle.importKey("jwk", …)` 可以直接吃 JWK。
把 PEM 证书搬进来意味着自己写 ASN.1 解析器——那是纯粹为兼容而上缴的复杂度。

## 变更内容

### 原设计

| 上游构件 | 职责 | 载体 |
|---|---|---|
| `googleCerts []*rsa.PublicKey` + `googleCertsRefreshAt` | 证书缓存 | 客户端实例内存 |
| `GET /oauth2/v1/certs` | 取 `kid → PEM` 表 | 远端 |
| `x509.ParseCertificate` + `pem.Decode` | PEM → RSA 公钥 | Go 标准库 |
| `jwt.Parse(..., WithExpirationRequired, WithValidMethods(RS256))` | 验签 + 声明校验 | `golang-jwt/jwt/v5` |
| `oauth2.Config.Exchange` | 授权码 → access token | `golang.org/x/oauth2` |

### 新设计

| 本项目构件 | 对应上游 | 说明 |
|---|---|---|
| `src/domain/social/google/jwt.ts` | `jwt.Parse` 的形状部分 | base64url 拆三段、解 header/payload、`alg` 必须是 `RS256`、`exp` 必填 |
| `src/domain/social/google/verify.ts` | keyfunc + 证书缓存 | WebCrypto `importKey("jwk")` + `verify(RSASSA-PKCS1-v1_5, SHA-256)`；证书可由调用方注入（与上游 `client.googleCerts` 同构） |
| `src/domain/social/google/token.ts` | `CheckGoogleToken` | 证书来源选择 → 验签 → `iss` / `aud` / `azp` 规则 → JWT 形状闸门 → 授权码流程 |
| `src/http/routes/authenticate-social.ts` | `api_authenticate.go::AuthenticateGoogle` | `POST /v2/account/authenticate/google`（server-key 类） |

证书从 **`https://www.googleapis.com/oauth2/v3/certs`（JWKS）** 取：
它的 `keys[]` 本来就带 `kid` / `n` / `e`，`importKey` 一步到位，也省掉自写 ASN.1 的整块风险。

## 可观测语义逐条对齐

下列各条都有测试钉住（`tests/integration/social/google-token.test.ts`，
签名的 RSA 密钥由测试本机生成、公钥注入被测代码，**不访问任何远端**）：

1. **`iss` 只接受两个值**：`accounts.google.com` 与 `https://accounts.google.com`；
   缺失或其它值一律拒。
2. **`exp` 必填**，且过期的 token 被拒（上游 `WithExpirationRequired()`）。
3. **`aud` 必须是字符串**：数组 `aud`（Google 在多客户端场景会给数组）被拒，
   缺失被拒，不在配置集合里被拒。
4. **`azp` 若存在必须是字符串且在允许集合里**：`azp` 指向另一个 OAuth client 被拒，
   `azp` 不是字符串被拒；**`azp` 缺失是合法的**。
5. **没配置任何 client id 时只警告、放行**（上游 `NewClient` 的 `logger.Warn` 行为）：
   这是"运营者还没配好"与"随便谁都能登"之间的取舍，上游选了向后兼容，本项目跟随。
6. **JWT 形状的值绝不走授权码流程**：`strings.Count(idToken, ".") == 2` 的值即使验签失败，
   也只回 `google id token invalid`，**不发出任何外部请求**（用外部请求计数 = 0 判定）。
7. **授权码流程两步**：POST token endpoint（`grant_type=authorization_code`）→
   GET `games/v1/players/me?access_token=…`；`playerId` 为空是错误。
8. **失败对外只有一句话**：`Could not authenticate Google profile.`
   （`codes.Unauthenticated`），与上游 `core_authenticate.go` 第 774 行逐字一致；
   请求体里没有 token 时是 `Google access token is required.`（`InvalidArgument`）。

## 偏差（全部登记在案）

### 偏差 1：证书来源从 X.509 PEM 端点换成 JWKS 端点

`/oauth2/v1/certs` 与 `/oauth2/v3/certs` 是同一个密钥集的两个视图，Google 同时维护。
客户端不可见：两者都不进任何响应字段。真要出问题时也只影响本项目自己的验签，
而验签的判决（通过 / 不通过）与上游一致。

### 偏差 2：证书缓存按 TTL 而不是按证书的 `NotAfter` 到期

JWKS 里没有有效期字段，只有 `Cache-Control: max-age`。本项目用响应头给的 TTL 做缓存，
拿不到就退回一个保守的短 TTL；**上游"最早到期证书前 1 小时刷新"的语义无法逐字复制**。
可观测差异：证书轮换窗口（Google 会在旧密钥到期前一段时间内同时公布新旧两个 `kid`）
内本项目可能多取一次证书，或晚一点取到新证书。这两种情况都不改变验签判决，
因为新旧公钥同时有效正是轮换窗口的定义。

### 注记（非偏差）：刷新失败时不覆盖已有公钥缓存

上游刷新失败时直接返回错误，但**不**清空 `c.googleCerts`——旧证书继续可用，下一次调用
还会再试刷新。本项目照抄这条：刷新失败保留上一份，仅当"没有缓存且远端不可达"时才失败。

### 偏差 3：只做 Google，其余 provider 只做"未配置"守卫

Apple / Facebook / Steam / GameCenter 各自的密钥交换都需要真实凭据（Apple 的 `.p8` 私钥、
Facebook 的 app secret、Steam 的 publisher key），在没有凭据的环境里唯一诚实的可观测行为
就是上游那句"未配置"错误。M5 只为它们落配置守卫，真实凭据交换不在本里程碑范围
（v2-social.md 的「不做」段已登记）。

## 影响范围

- 受影响的 Req ID：REQ-0001-003（认证；本里程碑交付其 OAuth 分支的前半段）。
- 受影响的代码：`src/domain/social/google/*`（3 个文件）、
  `src/http/routes/authenticate-social.ts`、`src/domain/social/config.ts`（client id 与
  token endpoint 的显式配置）、`src/env.ts`（新增绑定）。
- 受影响的测试：`tests/integration/social/google-token.test.ts`。
- 不受影响：设备 / 邮箱 / 自定义认证与会话签发、其余 provider 的配置守卫行为、
  上游线格式（`AuthenticateGoogleRequest` / `Session` 由 `api_pb.ts` 提供）。

## 处置方式

- [ ] PRD 已同步更新（REQ-0001-003 的偏差备注）
- [ ] vN 计划已同步更新（ECN 索引、M5 追溯矩阵、M5 Review 记录）
- [ ] 追溯矩阵已同步更新（M5 的第二证据源引用 `/v2/account/authenticate/google`）
- [ ] 相关测试已同步更新（Google token 用例随本 ECN 落地）
