-- M8：派对目录（`GET /v2/party` 的数据源）。
--
-- 上游把目录放在进程内的 bluge 索引里（`LocalPartyRegistry.pendingUpdates` 定时批量刷），
-- 本项目换成一张表：**谁写、什么时候写、写没写进去**都能直接 SELECT 出来。
-- 隐藏派对不进目录这件事落在查询里（`hidden = 0`），于是"目录里看不到隐藏派对"
-- 是一句 SQL 就能验的事实，而不是一条容易漏掉的领域判断。
--
-- 多租户：主键第一段是 `tenant_id`，读写一律带它。
CREATE TABLE IF NOT EXISTS party_record (
  tenant_id   TEXT    NOT NULL,
  party_id    TEXT    NOT NULL,
  uuid        TEXT    NOT NULL,
  node        TEXT    NOT NULL,
  open        INTEGER NOT NULL,
  hidden      INTEGER NOT NULL,
  max_size    INTEGER NOT NULL,
  label       TEXT    NOT NULL,
  create_time INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, party_id)
);

-- 列表的固定顺序：新派对在前，同秒的按 id 升序（可复现的翻页顺序）。
CREATE INDEX IF NOT EXISTS party_record_listing
  ON party_record (tenant_id, create_time DESC, party_id ASC);

-- 隐藏位单独一条索引：目录查询恒带 `hidden = 0`。
CREATE INDEX IF NOT EXISTS party_record_hidden
  ON party_record (tenant_id, hidden);
