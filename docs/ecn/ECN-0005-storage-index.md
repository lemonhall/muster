# ECN-0005: 存储索引从 bluge 内存索引换成对权威表的声明式查询

## 基本信息

- **ECN 编号**：ECN-0005
- **关联 PRD**：PRD-0001
- **关联 Req ID**：REQ-0001-007（存储索引）
- **发现阶段**：v1-identity-storage（M2）编码中
- **日期**：2026-09-28

## 变更原因

上游的 `LocalStorageIndex`（`server/storage_index.go`）是一份**进程内 bluge 全文索引**：

- 写入时同步把文档喂进索引（`Write`），删除时按文档 id 摘掉（`Delete`）；
- 启动/重建时从权威表 `storage` 分页读回来重建（`rebuildIndex`）；
- 查询打在索引上（`List`），`index_only` 为真时直接返回索引里存的值副本，为假时拿命中回查权威表
  并按索引顺序重排；
- 查询串交给 bluge 的 `ParseQueryString`（`server/match_common.go`）解析。

放到 Cloudflare 上有三条硬约束让它不能照搬：

1. **workerd 里没有 bluge**，也没有可用的全文索引引擎；权威存储是 D1（SQLite）。
2. **Worker isolate 是短命的、且天然多副本**：一份"进程内索引"既不权威（冷启动即空），
   也多副本之间不一致。
3. 上游为此付出的代价在上游代码里看得很清楚：写了重建逻辑、写了"回查发现版本不符就重索引"，
   还要处理批内顺序（见下面 §偏差 1）。这些复杂度全部来自"索引与权威表是两份数据"。

## 变更内容

### 原设计

- 索引 = 内存 bluge 索引；索引声明在内存（`indexByName` / `indicesByCollection`）；
  查询串 → bluge 查询；`index_only` → 返回索引里存的值副本。

### 新设计

- **索引声明**落在 D1 表 `storage_indexes`（`migrations/0002_storage.sql`，每条语句带 `tenant_id`，
  见 ECN-0001）；`CreateIndex` / `GetIndexes` 是对这张表的增查。
- **索引 = 对权威表的声明式查询**：查询串编译成打在 `storage_objects` 上的 SQL 谓词 + `ORDER BY`
  （`src/domain/storage/index/query.ts`），命中结果直接就是权威行。
- 于是"索引与权威表不一致"这个状态**在结构上不存在**：没有重建、没有回查重排、没有版本比对。

## 可观测语义逐条对齐

| 语义 | 上游（`storage_index.go` / `match_common.go`） | 本项目 |
|---|---|---|
| 成员资格 | `idx.Key == "" \|\| idx.Key == so.Key`，且至少一个声明字段存在（`mapIndexStorageFields` 返回 nil 就不进索引） | `membershipFragment`：`collection = ?` [+ `key = ?`] + `EXISTS(json_each(value) WHERE key IN (声明字段))` |
| 字段匹配 | 数字→numeric、字符串→keyword、bool→keyword `"T"`/`"F"`；数组逐元素各建一个字段 | `clauseFragment`：`json_each` 展开后按 `CAST(value AS TEXT)` 比文本/数字，`'T'`/`'F'` 比 `true`/`false` |
| 多子句组合 | bluge 布尔查询：空格分隔默认 OR，`+` 前缀为 must | `matchFragment`：must 部分 AND，should 部分 OR |
| 未声明字段 | 索引里没有该字段，引用它的子句匹配不到 | 编译成 `1 = 0`（保留 OR 结构，不是把子句删掉） |
| 读权限过滤 | `callerID != uuid.Nil` → `read:2 OR (read:1 AND owner:callerID)` | 同一条谓词，直接写在 WHERE 里（caller 为 nil 时不过滤） |
| 分页 | `limit+1` 取页，游标 `{Query, Offset, Limit, Order}`，四元组不符报 `invalid` | 同左（游标编码见 ECN-0004） |
| `index_only` | 返回索引里存的值副本（只含声明字段，`json.Marshal` 键名升序） | `projectValue`：按声明字段裁剪 + 键名升序序列化 |
| 缺索引 / limit 过大 | `index %q: not found`；`limit > MaxEntries` 只 warn | 同左（warn 在无 logger 的测试环境里无副作用） |
| 淘汰 | `count > uint64(float32(MaxEntries) * 1.1)` 时删掉最旧的 `count - MaxEntries` 条 | 查询时等价淘汰：成员数超线时只保留 `update_time DESC` 最新的 `MaxEntries` 条（见 §偏差 2） |

## 偏差（全部登记在案）

### 偏差 1：不复刻"批内残留"（唯一一处会影响结果的差异）

上游 `Write` 把一批对象塞进**同一个 bluge batch**，调用 `batch.Update(docID, doc)`。而 bluge 的
`Update` 只能删掉"进入本批之前**已经存在**"的同 id 文档，批内后写的同 id 文档顶不掉先写的那条，
于是同一个 `(collection, key, user_id)` 会在索引里留下**两条**，其中先写那条的值在权威表里已经
被覆盖、不复存在。

**复现（bluge v0.2.2，独立探针，不进仓库）**：内存索引里同一 batch 三次 `Update`（后两次同 id）
→ `Reader.Count()` = 3；同样两次 `Update` 拆成两个 batch → 1。

上游测试 `TestLocalStorageIndex_List/paginates correctly` 正是靠这个残留凑出"三页"（它的三条写入
里 u1 那两条落在同一个主键上）。我们的索引不存在副本，所以那种写法只能查到 2 条。

**处置：不复刻。** 理由：

- 它返回的是"权威表里已不存在的值"，且是**没有任何版本的旧值**；
- 上游自己的非 `index_only` 路径也会把这条陈旧文档按版本不符丢掉——只有 `index_only` 路径会漏出来；
- 我们的写路径是一次 D1 事务里的 upsert，结构上没有"批内两条同 id"这个中间态。

测试上的处理：`tests/integration/storage/index-list.test.ts` 里既断言"覆盖后只剩权威的那条"
（`test_overwriting_the_same_object_in_one_batch_leaves_no_stale_entry`，带复现证据），
也用一个**成员互不相同**的等价场景完整覆盖分页语义（三页、最后一页游标为空、无重复无遗漏）。

### 偏差 2：淘汰的决胜键

上游按 `update_time` 排序淘汰，而它的时间戳是**微秒级** `timestamppb`。本项目的时间戳是**秒级**
（与存储对象表一致），同一秒内的多条写入无法靠时间戳定序，所以淘汰顺序补上
`user_id DESC, key DESC` 做决胜键。**只有"同一秒内写入多条、且恰好越过淘汰线"这种场景**下，
保留哪几条会与上游不同；除此之外顺序一致（`update_time DESC` 为主序）。

### 偏差 3：并发写用例的轮数

上游 `TestLocalStorageIndex_Write/allows concurrent writes to index` 用两个 goroutine 各写 1000 次
同一个对象，盯的是"共享可变索引在并发写下的崩溃/串扰"。我们的索引没有共享可变状态，但保留了
同一件事的断言：并发写 + 并发读不报错、且同一 `(collection, key, user)` 反复写只剩一条。
轮数 1000 → 20：本地 workerd 上每轮都是一次真实事务，加轮数只拖长用例、不增加可观测结论。

### 偏差 4：查询语法只实现存储索引实际用到的子集

实现了：`*`/空串（匹配全部）、空格分隔的 OR、`+` 前缀的 must、`value.<字段>:<值>`、bool 的 `T`/`F`。
**未实现**的 bluge 语法（`-` 否定、短语引号、范围、通配符）一律**报 `invalid`**，而不是悄悄当成
别的语义。理由：静默降级会把"查得不对"伪装成"查得少"，这类错误最难发现。

## 影响范围

- 受影响的 Req ID：REQ-0001-007（M2 DoD 5/6）。
- 受影响的代码文件：`migrations/0002_storage.sql`（`storage_indexes`）、
  `src/domain/storage/index/{types,cursor,query,project,store,list}.ts`。
- 受影响的测试：`tests/integration/storage/index-write.test.ts`（上游 `TestLocalStorageIndex_Write`
  的 4 个 t.Run）、`tests/integration/storage/index-list.test.ts`（上游 4 个 t.Run + 偏差 1 + 删除）、
  `tests/integration/storage/index-cursor.test.ts`（游标与校验的边界分支）。
- 不受影响：对象 CRUD 的语义（`storage_objects` 仍是唯一权威表）、REST 面（索引不新增公开端点）。

## 处置方式

- [x] PRD 已同步更新（REQ-0001-007 偏差备注）
- [x] vN 计划已同步更新（ECN 索引、追溯矩阵、M2 Review 记录）
- [x] 追溯矩阵已同步更新（ECN 索引；M2 覆盖 57/57）
- [x] 相关测试已同步更新（含偏差 1 的显式断言与复现说明）
