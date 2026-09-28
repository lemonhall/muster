-- M2 存储引擎：集合 / 对象 / 权限 / 版本 / 列表（多租户）。
--
-- 与上游的形态差异（内部存储细节，不影响对外可观测行为）：
--   1. 上游一张 `storage` 表，主键 (collection, key, user_id)，`user_id` 为 uuid（全零 = 全局对象）；
--      我们加 `tenant_id` 作为主键首列，于是"每个游戏内一份存储"这件事在库结构里是显式的。
--   2. 上游 `read` / `write` 是列名（SQL 保留字，得靠引号）；这里取名 `read_perm` / `write_perm`，
--      语义与取值完全一致（读 0/1/2，写 0/1）。
--   3. 上游用 timestamptz；这里存 Unix 秒，REST 面输出 RFC3339（转换在 wire 层）。
--   4. `version` 是值的 MD5 十六进制（与上游一致；客户端把它当不透明令牌回传）。

CREATE TABLE storage_objects (
  tenant_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  key TEXT NOT NULL,
  -- 所有者。M2 的客户端写入者恒为调用者自己；"全局对象"（全零 uuid）留给运行时扩展层。
  user_id TEXT NOT NULL,
  value TEXT NOT NULL,
  version TEXT NOT NULL,
  read_perm INTEGER NOT NULL,
  write_perm INTEGER NOT NULL,
  create_time INTEGER NOT NULL,
  update_time INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, collection, key, user_id)
);

-- 列表查询三条路径（见 src/domain/storage/objects.ts::listObjects）都按
-- (collection, read_perm, key, user_id) 或 (collection, user_id, read_perm, key) 排序，
-- 各建一个复合索引；游标分页的比较元组与索引列顺序一致，避免临时排序。
CREATE INDEX storage_objects_by_collection_idx
  ON storage_objects (tenant_id, collection, read_perm, key, user_id);

CREATE INDEX storage_objects_by_owner_idx
  ON storage_objects (tenant_id, collection, user_id, read_perm, key);

-- 批量写的原子性守卫（见 src/domain/storage/objects.ts 顶部说明）。
--
-- 这不是业务表：它永远只有 0 行或 1 行，存在的唯一意义是把"业务前置条件"翻译成一条
-- CHECK 约束，好让条件不成立时**整个 batch 回滚**。条件成立时守卫行在同一批的末尾被删掉。
-- 用单行表而不是别的手段，是为了让"回滚"这件事由数据库事务负责，而不是靠应用层自觉。
CREATE TABLE storage_batch_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ok INTEGER NOT NULL CHECK (ok = 1)
);

-- 存储索引的**声明**（M2 的 REQ-0001-007）。
--
-- 上游的索引是进程内的 bluge 全文索引：写入存储对象时同步喂给内存索引，重启时从库里重放。
-- 本项目不这么做（Worker 的 isolate 随时会换、内存副本天生不一致），而是把索引当作
-- **对 storage_objects 的声明式查询**：这张表只存"索引长什么样"，查询时编译成 SQL。
-- 于是索引与权威数据永远一致，也没有淘汰/重建的窗口。可观测语义的对齐见
-- docs/ecn/ECN-0005-storage-index.md。
CREATE TABLE storage_indexes (
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  collection TEXT NOT NULL,
  -- 空串 = 该集合内所有 key 都进这个索引（上游 idx.Key == "" 的语义）。
  key TEXT NOT NULL,
  -- 索引哪些顶层字段（JSON 数组文本）。只有这里列出的字段可被查询命中。
  fields TEXT NOT NULL,
  -- 可排序字段（JSON 数组文本）。order 里出现 value.<f> 时用它排序。
  sortable_fields TEXT NOT NULL,
  -- 索引容量上限（上游 max_entries）。
  max_entries INTEGER NOT NULL,
  -- 只返回被索引字段的副本（上游 index_only）。
  index_only INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, name)
);
