# ECN-0004: 存储游标改用 base64url(JSON) 而不是 gob

## 基本信息

- **ECN 编号**：ECN-0004
- **关联 PRD**：PRD-0001
- **关联 Req ID**：REQ-0001-007（存储索引）
- **发现阶段**：v1-identity-storage（M2）编码中
- **日期**：2026-09-28

## 变更原因

上游有**两处**游标，都用 `base64.RawURLEncoding(gob.Encode(...))` 输出：

| 用途 | 上游结构（`server/`） | 实现点（本项目） |
|---|---|---|
| 对象列表分页 | `storageCursor{Key, UserID, Read}`（`core_storage.go`，`StorageListObjects`） | `src/domain/storage/cursor.ts` |
| 索引列表分页 | `indexListCursor{Query, Offset, Limit, Order}`（`storage_index.go`，`LocalStorageIndex.List`） | `src/domain/storage/index/cursor.ts` |

这套编码依赖 Go 的 `encoding/gob`。

我们跑在 workerd 上：**没有 gob，也不该为了一个内部游标去实现 gob**。而游标本身对客户端
是**不透明**的——没有任何官方 SDK 会去解它，客户端只做"上一页返回什么，下一页原样带回来"。

## 变更内容

### 原设计

- 游标 = `base64url(gob(<结构>))`，无填充（`RawURLEncoding`），两处都是。

### 新设计

- 对象列表：`base64url(JSON({"r":read,"k":key,"u":userId}))`，无填充。
- 索引列表：`base64url(JSON({"q":query,"o":offset,"l":limit,"r":order}))`，无填充。

两处都只有"编码/解码"这一点不同，其余逻辑（定位比较、四元组比对）与编码无关。

## 可观测语义不变论证

游标在协议里的可观测语义只有下面这些，逐条成立（对象列表三条 + 索引列表三条）：

1. **能往前走**：`decode(encode(c)) === c`，所以"把上一页的游标带回来"这件事在任何编码下都一样。
2. **坏游标报错文案**（对象列表）：上游对"base64 坏了"和"gob 坏了"都报同一句
   `Malformed cursor was used.`（InvalidArgument/400），我们逐字复刻这一句——因为它是**唯一**
   对外可见的文本，比上游的解码细节更稳定。
3. **换 query / limit / order 会被拒**（索引列表）：四元组的比对发生在解码之后，与编码无关。消息逐字对齐上游
   的 `invalid`/`ErrBadInput` 形态：`invalid cursor: query mismatch`、`invalid cursor: limit mismatch`、
   `invalid cursor: order mismatch`（比对顺序也照上游：query → limit → order）。
4. **字符集安全**：两处都是无填充 `base64url`，可安全出现在 URL 查询串里（与上游同一个字符集，且不含
   `+`/`/`/`=`）。本项目的游标测试断言了这一点。

对象列表还有两条与编码无关的既有契约，实现在 `src/domain/storage/objects/list.ts` 与
`core_storage.go::StorageListObjects` 一一对应：下一页从"上一页最后一个对象"之后**严格大于**
处开始；若服务端算出的游标与请求里带回来的相同，就返回空游标（防止客户端拿到翻不动的游标死循环）。

### 已知的文本级偏差（唯一一处）

上游把底层解码器自己的错误拼在冒号后面（`invalid cursor: illegal base64 data at input byte 3`、
`invalid cursor: unexpected EOF` 等），我们是固定文本：

- 非 base64url 字符 → `invalid cursor: illegal base64 data`
- 解出来不是四元组 JSON → `invalid cursor: malformed payload`

两条都是 **`invalid cursor:` 前缀 + InvalidArgument/400**，与上游同类；差异只在冒号后面的
细节文本，而那段文本本就是"具体解码器"的产物，不属于契约。若某天真要逐字复刻，改一个文件即可
（`cursor.ts`），不影响其他任何调用点。

## 影响范围

- 受影响的 Req ID：REQ-0001-007（M2 DoD 5：游标分页）。
- 受影响的代码文件：`src/domain/storage/cursor.ts`（对象列表）、
  `src/domain/storage/index/cursor.ts`（索引列表）、`src/domain/storage/index/list.ts`（生成游标与
  `limit+1` 取页）。
- 受影响的测试：`tests/integration/storage/index-cursor.test.ts`（编解码往返、三类不匹配、
  两类坏游标）；`tests/integration/storage/index-list.test.ts`（三页翻完、最后一页游标为空）；
  `tests/integration/storage/list.test.ts`（对象列表的分页与坏游标文案）。

## 处置方式

- [x] PRD 已同步更新（REQ-0001-007 偏差备注）
- [x] vN 计划已同步更新（ECN 索引、追溯矩阵）
- [x] 追溯矩阵已同步更新（ECN 索引）
- [x] 相关测试已同步更新（游标往返与拒绝矩阵）
