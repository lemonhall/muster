# ECN-0006: 实时层建在 Durable Object 上（会话分片 + 每租户注册表）

## 基本信息

- **ECN 编号**：ECN-0006
- **关联 PRD**：PRD-0001
- **关联 Req ID**：REQ-0001-008（实时协议骨架）、REQ-0001-009（会话注册表与在线状态）
- **发现阶段**：v1-realtime-chat（M3）编码中
- **日期**：2026-09-28

## 变更原因

上游的实时层建立在"一个长驻进程"这个前提上：

- 每条连接一个 `sessionWS`（`server/session_ws.go`），它自己持有 socket、跑读循环、发心跳；
- 在线状态放在**进程内的 map**里（`server/tracker.go` 的 `LocalTracker`）；
- 关注关系与事件投递放在另一张进程内 map 里（`server/status_registry.go` 的 `LocalStatusRegistry`）；
- WebSocket 与 REST 各监听一个端口。

Cloudflare Workers 上没有"常驻进程内状态"这个东西：请求之间只有 Durable Object 有状态，
连接必须挂在 DO 上才能跨请求活着。把进程内 map 直接照搬过来是不可能的，必须换载体。

## 变更内容

### 原设计

| 上游构件 | 职责 | 生命周期 |
|---|---|---|
| `sessionWS`（`session_ws.go`） | 一条连接的读循环、心跳、发送 | 随连接生灭的 goroutine |
| `LocalTracker`（`tracker.go`） | 按 stream 组织的 presence | 进程生命周期 |
| `LocalStatusRegistry`（`status_registry.go`） | 关注关系 + 事件投递 | 进程生命周期 |
| socket 监听器 | 只处理 WS 升级，与 API 端口分离 | 进程生命周期 |

### 新设计

| 本项目构件 | 对应上游 | 说明 |
|---|---|---|
| `SessionShard`（`src/durable/session-shard.ts`） | `sessionWS` | **一条连接一个 DO**，实例名 `tenantId\|sessionId`；用 Hibernation API（`ctx.acceptWebSocket`），连接元数据 `serializeAttachment` |
| `SessionRegistry`（`src/durable/session-registry.ts`） | `LocalTracker` + `LocalStatusRegistry` 的在线状态那一半 | **每租户一个 DO**，实例名 = `tenantId`；状态落在 SQLite（`src/durable/session-store.ts`） |
| `/ws` 路由（`src/http/routes/socket.ts`） | socket 监听器 | 与 REST 同一个 Worker；`/ws` 不在上游 REST 表里，所以走 `handlePublic`，不参与上游对账 |
| 分片心跳 + 注册表巡检 | `ping_period_ms` / `pong_wait_ms` | 见"偏差 1" |

为什么"一条连接一个分片"而不是"一个用户一个分片"：会话断开只需要影响它自己，
同一用户的第二条连接不必等第一条清理完；跨租户也天然隔离（键里带 `tenantId`）。

## 可观测语义逐条对齐

对上、对外可观测的部分一律照上游，逐条都有测试钉住：

1. **握手**：`format` 只认 `""`/`json`/`protobuf`（缺省 json），其余 400 `Invalid format parameter`；
   有 `Authorization` 头就必须是 `Bearer ` 前缀，否则 401 `Missing or invalid token`；没有头才退到查询参数
   `token`；令牌解析失败 / 会话已吊销 / 账号不存在 → 同一条 401。失败响应是 Go `http.Error` 的形状
   （`text/plain; charset=utf-8` + 末尾换行）。→ `src/realtime/handshake.ts`
2. **帧类型必须与协商格式一致**：json ↔ 文本帧、protobuf ↔ 二进制帧；混用或畸形帧 → 断开连接
   （不是"当成空消息继续"）。
3. **错误语义**：`MISSING_PAYLOAD "Missing message."`、`UNRECOGNIZED_PAYLOAD "Unrecognized message."`、
   `BAD_INPUT`（非法 user id / status 超长）；三种错误都是**先发错误帧、再关连接**。
4. **心跳**：`ping` 原样回带 `cid` 的 `pong`；`pong` 什么都不做（上游 `pipeline_ping.go`）。
5. **status 三兄弟**（`pipeline_status.go`）：空入参回空快照/空信封；非法 user id → `BAD_INPUT
   "Invalid user identifier"`；空 username → `BAD_INPUT "Invalid username"`；不能关注自己；
   只订阅**查得到**的账号；状态文本上限 2048 **字节**；空 `status` 等价于下线。
6. **presence 是每会话的**：同一用户两条连接就是两条 presence（`ListByStream` 的原样行为）。
7. **事件投递**：只发给"关注了该用户"的会话；`status_update` 有值且此前已在线时同时产生
   `joins:[新]` 与 `leaves:[旧]`（`tracker.Update` 的行为）。
8. **握手时自动关注自己**：上游 `socket_ws.go` 把 `statusRegistry.Follow(sessionID, {userID})`
   排在 `tracker.TrackMulti` 之前，而 status stream 的 presence 不是 hidden，所以 `status=true`
   的连接会立刻收到一条**关于自己**的 join。这条看着像笔误，其实是既有行为（客户端 SDK 观察得到），
   也是后续"自己的通知"能送达的通道，故照抄。

## 偏差（全部登记在案）

### 偏差 1：保活从 WS 控制帧换成"分片心跳 + 注册表巡检"（唯一会影响可观测行为的一条）

上游：每 `socket.ping_period_ms`（默认 15000ms）发一个 **WebSocket 控制帧 ping**，
读超时 `socket.pong_wait_ms`（默认 25000ms），超时即关闭连接。

本项目：Durable Object 的 WebSocket **不把控制帧交给我们**（平台自己管连接活性），
发不出 ping。若照抄"25s 没有入站帧就断开"，会把"没人说话的健康连接"全部误杀——
上游的客户端能活下来，靠的是服务端先发 ping、客户端运行时自动回 pong。所以这里换成应用层等价物：

- 分片 DO 每 `SESSION_TOUCH_INTERVAL_MS`（20s）向注册表 `/touch` 一次；
- 注册表超过 `SESSION_EVICT_AFTER_MS`（60s = 3 个心跳周期）没收到就判该会话离线，
  并给关注者补一条 leave。

可观测差异有三条，逐条说清：

1. 客户端收不到服务端的 WS 控制帧 ping（平台层可能有它自己的保活，但那不是我们的契约）；
2. 客户端**不会**因为"长时间不说话"被服务端主动断开；上游会。这对使用者是**更宽松**的一侧，
   且不影响任何 SDK 的正常用法；
3. 真断开的清理主要靠平台回调（`webSocketClose` / `webSocketError`，两条路都幂等），
   巡检只是"分片自己没了、连回调都发不出来"时的兜底。

证据：`tests/integration/realtime/session-lifecycle.test.ts`（心跳三条 + 兜底一条 + 幂等一条）。

### 偏差 2：会话 id 用 UUIDv4 而不是上游的 UUIDv1

上游 `uuid.Must(sessionIdGen.NewV1())`（时间有序）。本项目用 `crypto.randomUUID()`。
会话 id 对客户端是不透明的（只出现在 presence 与日志里），没有任何协议语义依赖它的时间序——
上游自己也只是习惯性用 v1。若将来需要"按创建时间排序会话"，再换实现。

### 偏差 3：M3 阶段未接通的消息类型一律 `UNRECOGNIZED_PAYLOAD` + 关闭（**临时**）

M3 只接通 `ping`/`pong`/`status_*`；频道、对局、派对、RPC、流都落到"认得出类型但没有处理函数"
这条路上——而这条路的形状（错误码、消息文本、随后关连接）与上游完全一致，差别只在"什么时候接通"。
M4 起逐条替换，替换完这条偏差消失。

### 偏差 4：多节点一致性由"每租户一个注册表 DO"保证（比上游更强）

上游的状态是每节点一份进程内 map，跨节点可见性取决于它自己的同步路径；
本项目每租户只有一个注册表实例，同一租户内不存在"两个节点各有一半真相"的窗口。
代价：热点租户的注册表是单点串行（v1 接受，v2 用实测数据再评估分片/中继）。

### 偏差 5：本机测试池无法模拟"优雅驱逐后恢复"

`evictDurableObject()` 在本机 vitest-pool-workers 0.22.0 上会挂死不返回，
`abortAllDurableObjects()` 则把连接一起杀掉（已实测）。因此 Hibernation **只覆盖到我们自己的责任**：
连接元数据挂在 socket 上（`test_the_connection_metadata_lives_on_the_socket_not_in_memory`），
平台那一半（驱逐后连接真的还能用）留给线上验收。这条同时登记在 M3 Review 的残余风险里。

## 影响范围

- 受影响的 Req ID：REQ-0001-008（M3 DoD 1/2/3）、REQ-0001-009（M3 DoD 4/5）。
- 受影响的代码：`src/realtime/*.ts`、`src/durable/{session-shard,session-registry,session-store,registry-call}.ts`、
  `src/http/routes/socket.ts`、`wrangler.jsonc`（DO 绑定与 migration `m3-sessions`）、`src/env.ts`。
- 受影响的测试：`tests/integration/realtime/`（6 个文件）、`tests/e2e/realtime.e2e.test.ts`。
- 不受影响：REST/RPC 面（`/ws` 不在上游 REST 表里）、身份与存储的语义、上游协议的线格式
  （由 `realtime.proto` 生成物提供，本 ECN 不动它）。

## 处置方式

- [x] PRD 已同步更新（REQ-0001-008/009 的偏差备注）
- [x] vN 计划已同步更新（ECN 索引、M3 追溯矩阵、M3 Review 记录）
- [x] 追溯矩阵已同步更新（ECN 索引；M3 覆盖 1/1 ported）
- [x] 相关测试已同步更新（心跳、兜底清理、幂等清理、元数据持久化）
