-- M7 匹配与对局：对局目录（`GET /v2/match` 的数据源）。
--
-- 与上游的形态差异（见 docs/ecn/ECN-0011-match-on-durable-objects.md）：
--   1. 上游的可查询对局目录是 bluge 内存索引（进程重启即重建），这里落成 D1 表；
--   2. 上游只索引**权威对局**的标签，中继对局是"从 tracker 里数出来的"；
--      这里两类对局都写一行（中继对局的 `label` 恒为空串），于是列表端点的
--      数据源只有一个；
--   3. 上游按 `-_score, -create_time` 排序，同秒创建的顺序未定义；这里补
--      `match_id` 升序做决胜（ECN-0011 偏差 8）。
--
-- 多租户（ECN-0001）：`tenant_id` 是主键首列，所有查询都必须带上它。

CREATE TABLE match_record (
  tenant_id     TEXT    NOT NULL,
  match_id      TEXT    NOT NULL,
  uuid          TEXT    NOT NULL,
  node          TEXT    NOT NULL,
  authoritative INTEGER NOT NULL,
  label         TEXT    NOT NULL DEFAULT '',
  size          INTEGER NOT NULL DEFAULT 0,
  create_time   INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, match_id)
);

-- 列表的默认路径：按创建时间倒序取前 N 条。
CREATE INDEX match_record_list_idx ON match_record (tenant_id, create_time DESC, match_id);

-- `label` 过滤是**整串相等**（上游 keywords 项查询），用一条普通索引就够。
CREATE INDEX match_record_label_idx ON match_record (tenant_id, label);
