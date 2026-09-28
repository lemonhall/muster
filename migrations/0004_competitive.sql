-- M6 经济与竞技：钱包、账本、排行榜与锦标赛（多租户）。
--
-- 与上游的形态差异（内部存储细节，见 docs/ecn/ECN-0010-competitive-on-d1.md）：
--   1. 上游把排行榜与锦标赛合并成一张 `leaderboard` 表（`reset_schedule` /
--      `max_num_score` / `join_required` 这些列两者共用），这里沿用同一形态：
--      一张表，`join_required` / `max_num_score` 非零即“是锦标赛”。
--   2. 上游 `leaderboard_record` 的主键是 `(owner_id, leaderboard_id, expiry_time)`；
--      这里把 `tenant_id` 提到首列（ECN-0001），列顺序与判重键的语义不变。
--   3. 上游 `users.wallet` 是 jsonb 列；这里同一个语义存 TEXT（JSON 文本），
--      因为 D1 没有 jsonb。`{"value":984}` 与 `{"v":1}` 的比较/累加全在应用层做。
--   4. 上游 `wallet_ledger.id` 是 uuid 主键，`changeset` / `metadata` 是 jsonb；
--      这里统一 TEXT + Unix 秒。

-- 钱包：与上游同形，挂在 `users` 上（一个用户一个钱包，不是一张独立表）。
ALTER TABLE users ADD COLUMN wallet TEXT NOT NULL DEFAULT '{}';

-- 钱包账本：每次 `updateLedger=true` 的钱包变更写一行。
-- 上游列是 (id, user_id, changeset, metadata, create_time, update_time)。
CREATE TABLE wallet_ledger (
  tenant_id   TEXT    NOT NULL,
  id          TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  changeset   TEXT    NOT NULL,
  metadata    TEXT    NOT NULL DEFAULT '{}',
  create_time INTEGER NOT NULL,
  update_time INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- 账本列表：`WHERE tenant_id = ? AND user_id = ? ORDER BY create_time DESC`，
-- 游标按 (user_id, create_time, id) 元组定位。
CREATE INDEX wallet_ledger_user_idx ON wallet_ledger (tenant_id, user_id, create_time, id);

-- 排行榜 / 锦标赛的定义。一张表两种角色（与上游一致）。
-- 纯排行榜：`join_required = 0`、`duration = 0`、`max_num_score = 0`。
-- 锦标赛：`duration > 0`（`join_required` / `max_num_score` / `max_size` 决定玩法）。
CREATE TABLE leaderboard (
  tenant_id        TEXT    NOT NULL,
  id               TEXT    NOT NULL,
  authoritative    INTEGER NOT NULL DEFAULT 0,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  operator         INTEGER NOT NULL DEFAULT 0,
  reset_schedule   TEXT    NOT NULL DEFAULT '',
  metadata         TEXT    NOT NULL DEFAULT '{}',
  create_time      INTEGER NOT NULL,
  title            TEXT    NOT NULL DEFAULT '',
  description      TEXT    NOT NULL DEFAULT '',
  category         INTEGER NOT NULL DEFAULT 0,
  start_time       INTEGER NOT NULL DEFAULT 0,
  end_time         INTEGER NOT NULL DEFAULT 0,
  duration         INTEGER NOT NULL DEFAULT 0,
  max_size         INTEGER NOT NULL DEFAULT 0,
  max_num_score    INTEGER NOT NULL DEFAULT 0,
  join_required    INTEGER NOT NULL DEFAULT 0,
  enable_ranks     INTEGER NOT NULL DEFAULT 1,
  size             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id)
);

-- 锦标赛目录：`GET /v2/tournament` 按 category / start_time 过滤后按 id 排序。
CREATE INDEX leaderboard_category_idx ON leaderboard (tenant_id, category, id);

-- 排行榜记录。`expiry_time = 0` 表示“不过这期”，非零表示这一期何时作废
-- （周期性重置的下一跳，或锦标赛的 end_time）。
--
-- 主键 `(tenant_id, owner_id, leaderboard_id, expiry_time)` 就是上游 upsert 的冲突键，
-- 于是“同一期里同一人只有一条记录”由库保证，而不是靠应用层先查后写。
CREATE TABLE leaderboard_record (
  tenant_id      TEXT    NOT NULL,
  leaderboard_id TEXT    NOT NULL,
  owner_id       TEXT    NOT NULL,
  username       TEXT,
  score          INTEGER NOT NULL DEFAULT 0,
  subscore       INTEGER NOT NULL DEFAULT 0,
  num_score      INTEGER NOT NULL DEFAULT 0,
  max_num_score  INTEGER NOT NULL DEFAULT 0,
  metadata       TEXT    NOT NULL DEFAULT '{}',
  create_time    INTEGER NOT NULL,
  update_time    INTEGER NOT NULL,
  expiry_time    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, owner_id, leaderboard_id, expiry_time)
);

-- 榜单列表：`WHERE leaderboard_id = ? AND expiry_time = ? ORDER BY score, subscore, owner_id`。
-- 三个方向键都在索引里，于是升序与降序共用一条索引（D1 是 SQLite，索引可双向扫）。
CREATE INDEX leaderboard_record_list_idx
  ON leaderboard_record (tenant_id, leaderboard_id, expiry_time, score, subscore, owner_id);

-- “某人在这期里有没有记录”与 owner 记录查询。
CREATE INDEX leaderboard_record_owner_idx
  ON leaderboard_record (tenant_id, leaderboard_id, owner_id, expiry_time);
