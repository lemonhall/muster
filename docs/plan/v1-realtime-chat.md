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
| `proto/` + `src/proto/` | 上游 proto 的引入与生成产物（保留版权头） |
| `src/realtime/envelope.ts` | 帧解析/序列化（二进制） |
| `src/realtime/handlers/*.ts` | 各消息类型的处理 |
| `src/durable/session-shard.ts` | 会话分片 DO（WebSocket 休眠、连接表） |
| `src/durable/session-registry.ts` | 全局会话注册表 DO |
| `src/durable/channel.ts` | 频道 DO（成员、presence、消息持久化） |
| `src/domain/status/registry.ts` | 状态订阅与在线状态 |
| `tests/integration/realtime/*.test.ts` | 编解码、错误码、ping/pong |
| `tests/integration/channel/*.test.ts` | 频道语义与消息规则 |
| `tests/e2e/realtime-chat.e2e.test.ts` | 端到端：两客户端进同一 ROOM 互发消息 + 历史读取 |

## Steps

1. **红**：写编解码往返测试 + 未鉴权握手被拒 + 伪造帧错误码测试，`npm test` → 预期失败。
2. **绿**：引入 proto 生成编解码器 + 实现 `/ws` 与 `ping`/`pong`/`error`，跑到绿。
3. **红**：写会话注册表与状态订阅测试（两连接 presence 不丢不重、断连清理）。
4. **绿**：实现会话分片 DO + 注册表 DO + 状态订阅，跑到绿；`npm run e2e` 覆盖 M3 场景。
5. **红**：写频道测试（三类 join/leave/presence、持久化开关、编辑删除权限）。
6. **绿**：实现频道 DO 与消息路径，跑到绿。
7. **E2E（M4）**：两客户端 ROOM 互发 10 条 + 第三客户端读历史。
8. **覆盖矩阵回填**：`api_channel` 与频道相关条目推进状态。

## Risks

| 风险 | 缓解 |
|---|---|
| DO WebSocket 休眠与自定义心跳/超时语义冲突 | 用 alarm 驱动超时清理，连接元数据用 `serializeAttachment` 持久化；写测试覆盖休眠-唤醒路径 |
| 单 DO 吞吐成为瓶颈（热门房间） | v1 先保证语义正确；把"每房间单 DO"作为已知上限写进差异列表，v2 再评估分片/中继 |
| 上游二进制协议有隐含约定（如 `cid` 相关性、`Error.code` 映射） | 以生成的 proto + 上游 socket 相关代码为唯一依据，逐条写进测试 |
| 长连接测试不稳定（时序抖动） | E2E 用轮询 + 超时上界断言，不用固定 sleep；失败时 dump 帧日志 |

## Evidence

（执行时回填）
