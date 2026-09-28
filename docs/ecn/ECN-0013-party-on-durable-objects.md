# ECN-0013: 派对建在 Durable Object + D1 上

## 基本信息

- **ECN 编号**：ECN-0013
- **关联 PRD**：PRD-0001
- **关联 Req ID**：REQ-0001-019（派对）
- **发现阶段**：v3-party-runtime（M8）实现时
- **日期**：2026-09-29

## 变更原因

上游的派对是一个**进程内的内存对象**：`server/party_handler.go` 里一个 `PartyHandler`
拿着 `map[partyID]*Party`，成员、加入请求、队长、匹配票都在这张表里；派对目录则写在
bluge（本地全文索引）里，`ListParties` 用 lucene 语法查它。

workerd 上没有"进程内一张全局表"这种载体：一个 isolate 只服务一段请求，请求之间不保证
同进程；跨租户共享一张内存表也违反 ECN-0001 的租户隔离。所以派对必须有一个**有单点定序
能力的持久载体**。

Durable Object 正好是这个载体：一个派对一个实例，实例内是 SQLite，所有进入的帧串行处理。
它顺带解决了上游的一个真实缺陷——上游派对状态在进程重启后**全部消失**。

## 变更内容

### 原设计

- 派对状态：`map[partyID]*Party`，进程内存，重启即丢。
- 派对目录：bluge 索引（`partyIndex`），`ListParties` 走 lucene 查询 + 排序。
- 游标：上游把 `api.PartyList` 的游标做成 gob 编码的内部结构。
- 断连：会话断开时上游只把 presence 从 tracker 摘掉，**待批准的加入请求留着**。

### 新设计

- **一个派对一个 DO**（`Party`），键是 `租户|uuid`，成员表 / 加入请求 / 队长 / 元数据都
  落在该实例的 SQLite 里（`PartyMembers` / `PartyRequests`）。
- **目录是一张 D1 表** `party_record(tenant_id, party_id, uuid, node, open, hidden,
  max_size, label, create_time)`，两个索引支撑"按 create_time+party_id 翻页"与
  "按 label 查"。列表端点的排序在 SQL 里固定。
- **游标是 `base64url(JSON)`**，与 ECN-0004 / ECN-0008 / ECN-0010 同一套编码。
- **断连清待批请求**：会话断开时删掉该会话在派对里的待批准加入请求（见偏差 5）。

## 偏差清单

| # | 偏差 | 为什么可接受 / 是否客户端可见 |
|---|---|---|
| 1 | 派对状态落在每个派对 DO 的 SQLite 里，不是进程内存 | **不可见**（除"重启后派对还在"这一点，那是增强）。收益：跨实例一致、崩溃不丢；代价：单派对吞吐受该 DO 串行限制 |
| 2 | 目录从 bluge 换成 D1 `party_record` 表，且**排序固定**（`create_time` 升序、同刻按 `party_id`） | 上游的 bluge 排序在等值条件下不保证先后；本项目把它固定下来，才让"翻页不漏不重"可以被测。客户端看到的仍是同一份列表语义 |
| 3 | 列表游标从 gob 换成 `base64url(JSON)`，且存的是**归一后**的查询串（空 → `*`） | 不可见（游标对 SDK 不透明，不与上游互换）。归一化是为了让"同一组过滤条件"始终算出同一个游标 |
| 4 | 标签语法错误的**细节文案**来自 JS 引擎，不是上游 Go 的解析器 | 可见但可忽略：前缀 `Invalid party label:` 全字对齐，冒号后的细节由引擎决定（前端只展示，不做分支） |
| 5 | 会话断开时**清掉该会话在派对里的待批准加入请求**；上游此时留着 | **刻意收紧**：上游留着的那条请求指向一个已经不在的会话，队长批准它会失败并留下垃圾。清掉是"宁可少一条僵尸请求"，配置与判据都写在 `src/durable/session-party.ts` |

## 为什么这些偏差可接受

**对外部客户端不可见**：`party_*` 十一条帧的**校验顺序**与**逐字文案**逐行对齐
`server/pipeline_party.go`（含三处上游笔误：`party_leave` 从不失败、`party_create` 的
`<0 || >256` 判据、`party_matchmaker_remove` 误用 `Error closing party:` 前缀）；
`GET /v2/party` 的 `limit` 范围、`open` / `label` / `min_size` / `max_size` 四个过滤器与
游标三项一致性对齐 `server/api_party.go::ListParties`。

**多租户语义变强**：上游是"一个进程一个游戏"；muster 是"一个租户一张目录表、一个派对一个
isolate"，同账号下多个游戏的数据同时隔离。

## 影响范围

- 受影响的 Req ID：REQ-0001-019（验收口径不变：十一条帧 + 目录端点可观测行为一致）。
- 受影响的计划：[v3-party-runtime.md](../plan/v3-party-runtime.md)（M8）的 DoD 1/2/3 直接对应本文。
- 受影响的代码：`src/domain/party/*`、`src/durable/party*.ts`、`src/durable/session-party.ts`、
  `src/realtime/pipeline-party*.ts`、`src/http/routes/party.ts`、`src/wire/party.ts`、
  `migrations/0007_party.sql`。
- 受影响的测试：`tests/unit/party/`、`tests/integration/party/`、`tests/e2e/party.e2e.test.ts`。

## 处置方式

- [x] PRD 已同步（REQ-0001-019 的偏差备注）
- [x] vN 计划已同步（v3-party-runtime.md 的 Scope / Risks）
- [x] 追溯矩阵已同步（ECN 索引）
- [x] 相关测试已同步（`tests/integration/party/`、`tests/unit/party/`）
