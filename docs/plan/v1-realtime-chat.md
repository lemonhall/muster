# v1-realtime-chat — 实时协议骨架与频道聊天（M3 + M4）

## Goal

让长连接这条命门在 Cloudflare 上跑起来：`/ws` 握手、二进制 `Envelope` 编解码、心跳与错误语义、会话注册表与在线状态，进而在其上实现三类频道与聊天（含持久化历史）。这一块决定整个项目是否可行，因此 M3 的第一个任务就是"字节级互通"。

## PRD Trace

- REQ-0001-008（实时协议骨架）
- REQ-0001-009（会话注册表与在线状态）
- REQ-0001-010（频道与聊天）

## Scope

**做（M3）**

- `/ws`：查询参数 `token`/`format`/`status` 语义对齐；握手鉴权失败即关闭。
- 编解码：由上游 `realtime.proto` 生成编解码器（`@bufbuild/protobuf` 或等价的 generated code），禁止手写近似实现。
- `Envelope` 的 51 个消息类型至少完成"可解析 + 可回带 `cid`"的冒烟；本版实际接通：`ping`/`pong`、`error`、`status_*`、`rpc` 占位。
- 会话注册表：**全局注册 DO** 记录 `user_id ↔ session_id ↔ connection`；每个连接挂在一个**会话分片 DO**（可休眠）上。
- 在线状态：`status_follow`/`status_unfollow`/`status_update` 及 presence 事件，语义对齐上游（含离线/上线去重）。

**做（M4）**

- 频道类型：`ROOM`、`GROUP`（无群组数据时按上游规则拒绝）、`DIRECT_MESSAGE`。
- 加入/离开、presence 事件、隐藏成员（`hidden`）、持久化开关（`persistence`）。
- 消息：发送（`channel_message_send`）、回执（`channel_message_ack`）、编辑、删除、广播（`channel_message`）。
- 历史：持久化消息落 DO SQLite（每频道一个 DO，单点定序），支持按游标分页读取。

**不做**

- 匹配器与对局（M7）；派对（M8）；对频道消息的全文检索（后续）。
- 跨区域消息投递优化（先做正确性，性能在 v2 用实测数据说话）。

## Acceptance

见 [v1-index.md](./v1-index.md) 的 M3 DoD（5 条）与 M4 DoD（5 条）。

## Files

| 路径 | 作用 |
|---|---|
| `proto/realtime.proto`、`proto/api/api.proto` + `src/proto/*.ts` | 上游 proto 的引入与生成产物（保留版权头，`npm run proto:gen` 生成） |
| `src/realtime/envelope.ts` | 帧解析/序列化（`json` / `protobuf` 两种线格式） |
| `src/realtime/handshake.ts` | `/ws` 握手参数与鉴权（`format`/`token`/`status`/`lang`） |
| `src/realtime/pipeline.ts` | 入站帧的分发：`ping`/`pong`/`status_*`，及其余类型的错误行为 |
| `src/realtime/{errors,presence,identifiers,socket-meta}.ts` | 错误帧、presence 线格式、user id 规范化、会话元数据的头编码 |
| `src/durable/session-shard.ts` | 会话分片 DO（一条连接一个，Hibernation API + 心跳） |
| `src/durable/session-registry.ts` | 每租户一个的会话注册表 DO（在线状态、关注关系、事件投递） |
| `src/durable/session-store.ts` | 注册表的存储层（`sessions` / `follows` 两张表与全部 SQL） |
| `src/durable/channel.ts`（M4） | 频道 DO（成员、presence、消息持久化） |
| `tests/integration/realtime/*.test.ts` | 编解码、握手、管线语义、注册表、会话生命周期 |
| `tests/integration/channel/*.test.ts`（M4） | 频道语义与消息规则 |
| `tests/e2e/realtime.e2e.test.ts` | 端到端：真 WebSocket 上的握手 / ping-pong / 状态订阅与事件 |
| `tests/e2e/realtime-chat.e2e.test.ts`（M4） | 端到端：两客户端进同一 ROOM 互发消息 + 历史读取 |

## Steps

1. ~~**红**：写编解码往返测试 + 未鉴权握手被拒 + 伪造帧错误码测试，`npm test` → 预期失败。~~ ✅
2. ~~**绿**：引入 proto 生成编解码器 + 实现 `/ws` 与 `ping`/`pong`/`error`，跑到绿。~~ ✅
3. ~~**红**：写会话注册表与状态订阅测试（两连接 presence 不丢不重、断连清理）。~~ ✅
4. ~~**绿**：实现会话分片 DO + 注册表 DO + 状态订阅，跑到绿；`npm run e2e` 覆盖 M3 场景。~~ ✅
5. **红**：写频道测试（三类 join/leave/presence、持久化开关、编辑删除权限）。
6. **绿**：实现频道 DO 与消息路径，跑到绿。
7. **E2E（M4）**：两客户端 ROOM 互发 10 条 + 第三客户端读历史。
8. **覆盖矩阵回填**：`api_channel` 与频道相关条目推进状态。

## Risks

| 风险 | 缓解 |
|---|---|
| DO WebSocket 休眠与自定义心跳/超时语义冲突 | 连接元数据用 `serializeAttachment` 持久化；心跳由分片 alarm 驱动、超时清理由注册表巡检兜底（[ECN-0006](../ecn/ECN-0006-realtime-on-durable-objects.md) §偏差 1）。休眠-唤醒只覆盖到"元数据在 socket 上"——本机测试池无法模拟优雅驱逐（§偏差 5） |
| 单 DO 吞吐成为瓶颈（热门房间） | v1 先保证语义正确；把"每房间单 DO"作为已知上限写进差异列表，v2 再评估分片/中继 |
| 上游二进制协议有隐含约定（如 `cid` 相关性、`Error.code` 映射） | 以生成的 proto + 上游 socket 相关代码为唯一依据，逐条写进测试 |
| 长连接测试不稳定（时序抖动） | E2E 用轮询 + 超时上界断言，不用固定 sleep；失败时 dump 帧日志 |

## Evidence

### M3-A 编解码与握手（REQ-0001-008）

`npx vitest run tests/integration/realtime` → 退出码 0（42 条，含 `envelope` 8 条 / `handshake` 7 条 /
`pipeline-basics` 7 条 / `pipeline-status` 13 条 / `registry` 7 条）。

- **字节级互通**：三条黄金向量由 `protobufjs`（与 `protoc-gen-es` 完全不相干的一套实现）独立编码后冻结，
  与本项目生成物逐字节比对（`tests/integration/realtime/envelope.test.ts`）：
  `Envelope{cid:"cid-1",ping:{}}` → `0a 05 63 69 64 2d 31 82 02 00`；
  `{cid:"c2",status_update:{status:{value:"in game"}}}` → `0a 02 63 32 ea 01 0b 0a 09 0a 07 69 6e 20 67 61 6d 65`；
  `{error:{code:3,message:"Invalid user identifier"}}` → `5a 1b 08 03 12 17 ...`。
- **51 个消息类型**：`Envelope.oneof message` 的 50 个字段逐个做二进制往返 +
  字段号连续断言（`cid` 是第 51 个字段，不在 oneof 里——这条曾经把测试写成 51 而报红）。
- **握手**：无令牌 / 坏 `Authorization` 前缀 / 非法 `format` / 跨租户伪签名令牌 → 逐字对齐的状态码与
  文本体；Bearer 与查询参数两条路都能升级成功；登出后两条路都被拒（搬运自上游
  `server/socket_ws_test.go::TestWebSocketRejectsSessionAfterLogout`）。

### M3-B 在线状态与事件投递（REQ-0001-009）

- **管线语义**（注册表用假的）：`MISSING_PAYLOAD` / `UNRECOGNIZED_PAYLOAD` / `BAD_INPUT` 的
  code + 逐字消息 + `close=true`；`status_follow` 的空入参、未知账号、自我关注、用户名解析、
  2048 字节边界（含"683 个汉字 = 2049 字节被拒"这条字符数 vs 字节数的反例）。
- **真实 DO + 真实 WebSocket**（`registry.test.ts`，每个用例一个随机租户）：
  自己的 presence 通知、无 `status` 标记的会话没有 presence、同一用户两条连接 → 两条 presence、
  关注者上线一条 join / 下线一条 leave、取消关注后不再收到、`status_update` 同时产生 joins + leaves、
  另一租户的"同 id 用户"既不进快照也不产生事件。
- **会话生命周期**（`session-lifecycle.test.ts`）：心跳闹钟的建立 / 续期 / 撤销、
  连接元数据挂在 socket 上、重复清理只通知一次、静默会话被巡检清掉并补 leave、畸形帧断开后 presence 被清。

### M3-C 端到端（REQ-0001-008/009，M3 DoD 4/5）

`npm run e2e` → 退出码 0。`tests/e2e/realtime.e2e.test.ts`（5 条）跑在真实 `wrangler dev --local`
进程上、用真 WebSocket 客户端：

整条 E2E 通道本机耗时 430s（5 files / 25 tests）。**文件串行**是刻意的：
并发跑 5 个文件时，本地 `wrangler dev` 的 ProxyWorker 会丢到 UserWorker 的连接
（`Error inside ProxyWorker ... Network connection lost`），表现为 6 条 `expected 500 to be 200`
加 2 条 WebSocket 用例超时；单跑任一文件、以及串行跑全部，都是全绿。这是**工装上界**，
不是被测代码的缺陷，因此 `vitest.e2e.config.ts` 用 `fileParallelism: false` 把基础设施抖动
挡在断言之外。要看服务端日志时设 `MUSTER_E2E_VERBOSE=1`。

1. json 与 protobuf 两种线格式的 ping → pong 且 `cid` 回带；
2. 两个客户端：A 订阅 B → 快照看到 B 在线 → B 改状态 → A 收到 joins(新) + leaves(旧) → B 断开 → A 收到 leave；
3. 后到的订阅者拿到的是**当前**状态快照（`raiding`），不是"还没上线"；
4. 取消关注后不再收到事件；空 `status_unfollow` 被安静地回执（只有 cid 的空信封）；
5. 未接通的消息类型返回逐字错误帧后关闭连接（protobuf 线格式下验的）。

环境证据：E2E 日志打印 `[e2e] muster 本地 Worker 已就绪：http://127.0.0.1:8788`，
目标进程是 `wrangler dev --local`（数据落在 `.wrangler/state`），**不连接任何 Cloudflare 账号资源**。
