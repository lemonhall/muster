-- M8：租户运行时模块仓（每个租户自己的游戏脚本）。
--
-- 为什么源码进 SQLite 而不进对象存储：模块是**代码**，但在这里它是**数据**——
-- 一次 `SELECT source FROM runtime_modules WHERE ...` 就能把某一个租户的版本读出来，
-- `sqlite3` / D1 控制台 / 本仓库的测试都能直接看见它。透明即信任：部署了哪个版本、
-- 什么时候写的、是谁写的，全在表里，不需要再开一个二进制工具去问。
--
-- 多租户（ECN-0001）：主键的第一段恒为 `tenant_id`，任何查询都必须先钉住租户。
-- 版本号是**单调递增**的整数：同一个 (tenant_id, name) 每次写入产生一个新版本，
-- 装载端按 (tenant_id, name, revision) 缓存 isolate，于是"换代码"= 换 revision。
CREATE TABLE IF NOT EXISTS runtime_modules (
  tenant_id    TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  revision     INTEGER NOT NULL,
  source       TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  PRIMARY KEY (tenant_id, name, revision)
);

-- 列表/装载都要"取某个模块的最新版本"，这条索引把那个查询变成一次索引定位。
CREATE INDEX IF NOT EXISTS runtime_modules_latest
  ON runtime_modules (tenant_id, name, revision DESC);
