# ECN-0003: 401 挑战头里的 realm 用本项目自己的名字

## 基本信息

- **ECN 编号**：ECN-0003
- **关联 PRD**：PRD-0001
- **关联 Req ID**：REQ-0001-004（会话与令牌）
- **发现阶段**：v1-identity-storage（M1）编码中
- **日期**：2026-09-28

## 变更原因

上游在 401 响应上补一个 `WWW-Authenticate` 头，取值是 `Bearer realm="nakama"`
（源码 `server/api.go::wwwAuthenticateFixWriter`，上游测试
`server/api_test.go::TestWWWAuthenticateHeaderOnUnauthenticated` 盯着它）。

这个头的用途是让 HTTP 客户端与浏览器知道"这里要 Bearer 凭据"，
而**不是**把 gRPC 的原始错误文案塞进 HTTP 头（上游为此专门包了一层 writer）。

本项目有两条互相冲突的约束：

1. **对外可观测行为要逐条对齐上游**——这个头属于可观测行为；
2. **仓库与产品名不得与上游产品沾边**（柠檬叔明确的商业约束，也是本项目取名的由来）。

`realm` 的取值把两条约束顶在了一起：照抄就是违反约束 2，去掉头就是违反约束 1。

## 变更内容

### 原设计（照抄）

- 401 → `WWW-Authenticate: Bearer realm="nakama"`。

### 新设计

- 401 → `WWW-Authenticate: Bearer realm="muster"`。

也就是说：**头的存在、形状、出现时机、"不放原始错误消息"这四条语义全部保留**，
只有 realm 的值换成本项目自己的名字。

### 判定依据

`realm` 在 HTTP 语义里是**保护区的名字**，由服务端自定义，客户端不得依赖它的具体取值
（RFC 9110 §11.6.1：realm 是给用户看的标识，不是协议常量）。官方 SDK 的处理路径是
"401 → 重新取/刷新凭据"，不会去比较 realm 字符串等于什么。

因此这一处偏差在**协议可互操作性**上为零影响，在**命名合规**上是必要条件。

### 明确不做

- 不做"两个头都给"（既发 `realm="nakama"` 又发 `realm="muster"`）：那是把别人的品牌名主动
  写进我们的响应，比照抄更糟。
- 不改 401 的其他任何部分：状态码、`content-type`、body 的 `{"code":16,"message":...}`
  形状与消息文本一律照搬上游。

## 影响范围

- 受影响的 Req ID：REQ-0001-004（验收口径追加一句"realm 取值以本项目命名为准"）。
- 受影响的 vN 计划：`v1-index.md` 追溯矩阵 REQ-0001-004 的 E2E 列已含该断言。
- 受影响的测试：
  - `tests/e2e/identity.e2e.test.ts`：真实 HTTP 下断言 `www-authenticate` 精确等于
    `Bearer realm="muster"`，并断言 401 body 不含原始错误文案之外的东西；
  - `tests/integration/identity.test.ts`：401 分支同时断言状态码与消息文本。
- 受影响的代码文件：`src/http/grpc.ts`（`UNAUTHENTICATED_CHALLENGE`，唯一实现点）。

## 处置方式

- [x] PRD 已同步更新（REQ-0001-004 偏差备注）
- [x] vN 计划已同步更新（ECN 索引、追溯矩阵）
- [x] 追溯矩阵已同步更新（ECN 索引）
- [x] 相关测试已同步更新（E2E 精确断言 realm）
