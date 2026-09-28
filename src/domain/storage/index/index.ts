/**
 * 存储索引（M2 / REQ-0001-007）。
 *
 * 上游 `server/storage_index.go` 的 bluge 内存索引，在本项目里被换成一问一答的
 * **声明式查询**：索引声明存在 `storage_indexes` 表里，查询编译成对 `storage_objects`
 * 的 SQL。理由与语义等价论证见 `docs/ecn/ECN-0005-storage-index.md`。
 *
 * 文件分工：
 *   - `types.ts`   索引声明与列表选项；
 *   - `cursor.ts`  分页游标（base64url(JSON)，四元组校验）；
 *   - `query.ts`   查询串 → SQL 谓词 / ORDER BY；
 *   - `project.ts` index_only 的字段裁剪与序列化；
 *   - `store.ts`   索引声明的建/查/列；
 *   - `list.ts`    列表（权限、淘汰、分页、投影）。
 *
 * 契约源（机器可读）：
 * 契约源: server/storage_index.go::LocalStorageIndex.List
 * 契约源: server/storage_index.go::LocalStorageIndex.Write
 * 契约源: server/storage_index.go::LocalStorageIndex.Delete
 * 契约源: server/storage_index.go::LocalStorageIndex.CreateIndex
 * 契约源: server/storage_index.go::LocalStorageIndex.GetIndexes
 * 契约源: server/storage_index.go::LocalStorageIndex.mapIndexStorageFields
 * 契约源: server/match_common.go::BlugeWalkDocument
 * 契约源: server/match_common.go::ParseQueryString
 */

export * from "./types";
export * from "./cursor";
export * from "./query";
export * from "./project";
export * from "./store";
export * from "./list";
