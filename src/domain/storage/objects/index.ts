/**
 * 存储引擎的领域逻辑（对外只用这个入口）。
 *
 * 全部语义逐条取自上游 `server/core_storage.go`（写入的三种版本模式、权限判定、
 * 批量原子性、列表排序与游标）。**批量原子性怎么做到的**：D1 的 `batch()` 是单事务
 * （任一语句失败即整体回滚），但它不会因为"条件不满足、影响 0 行"而失败。所以每一步
 * 先放一条**守卫语句**：把业务前置条件写成 `CHECK (ok = 1)` 约束下的插入，条件不成立
 * 就让整批失败回滚；条件成立时守卫行在同一批的末尾被删掉，表始终是空的。这样
 * "要么全成功要么全失败"就落在数据库事务上，而不是靠应用层的自觉。
 *
 * 多租户（ECN-0001）：每一条语句都带 `tenant_id`，没有"默认租户"回退。
 *
 * 文件分工：
 *   - `types.ts`  类型与常量（含 `NIL_USER_ID`、三个权限位常量）；
 *   - `sql.ts`    SQL 片段与语句构造（守卫、upsert、insert-only、OCC、单行查询）；
 *   - `write.ts`  批量写（含"第一个违规 op"的错误判定）；
 *   - `read.ts`   批量读（去重、权限过滤、确定性排序）；
 *   - `delete.ts` 批量删（守卫 + 整批回滚）；
 *   - `list.ts`   列举（五条路径、游标分页）。
 *
 * 契约源（机器可读）：
 * 契约源: server/core_storage.go::StorageWriteObjects
 * 契约源: server/core_storage.go::storagePrepBatch
 * 契约源: server/core_storage.go::storageWriteObjects
 * 契约源: server/core_storage.go::StorageReadObjects
 * 契约源: server/core_storage.go::StorageListObjects
 * 契约源: server/core_storage.go::StorageDeleteObjects
 * 契约源: server/core_storage.go::storageDeleteObjects
 * 契约源: server/core_storage.go::storageListObjects
 * 契约源: server/api_storage.go::ReadStorageObjects
 * 契约源: server/api_storage.go::WriteStorageObjects
 * 契约源: server/api_storage.go::DeleteStorageObjects
 * 契约源: server/api_storage.go::ListStorageObjects
 */

export * from "./types";
export * from "./sql";
export * from "./write";
export * from "./read";
export * from "./delete";
export * from "./list";
