-- M9 内购：已校验交易（多租户）。
--
-- 与上游 `purchase` 表的差异（见 docs/ecn/ECN-0014-console-and-ops.md）：
--   1. 首列是 `tenant_id`（ECN-0001）：同一个部署里多个游戏的交易号互不可见。
--   2. 冲突判定是 `(tenant_id, store, transaction_id)`，而上游是全局 `transaction_id`：
--      交易号只在**同一商店内**唯一，跨商店撞号不该互相覆盖。
--   3. `seen_before` 是显式列（上游用 `update_time > create_time` 反推，在秒精度下会
--      退化成 false）；`refund_time` 保留给退款通知，传统校验不覆盖它。
--   4. 时间列统一是 Unix **秒**（与其余表一致），上游是 timestamptz。

CREATE TABLE purchase (
  tenant_id      TEXT    NOT NULL,
  id             TEXT    NOT NULL,
  user_id        TEXT    NOT NULL,
  store          INTEGER NOT NULL,
  product_id     TEXT    NOT NULL,
  transaction_id TEXT    NOT NULL,
  purchase_time  INTEGER NOT NULL,
  refund_time    INTEGER NOT NULL DEFAULT 0,
  environment    INTEGER NOT NULL,
  raw_response   TEXT    NOT NULL DEFAULT '{}',
  seen_before    INTEGER NOT NULL DEFAULT 0,
  create_time    INTEGER NOT NULL,
  update_time    INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- 冲突判定与"这条收据属于谁"的反查共用这一个唯一索引。
CREATE UNIQUE INDEX purchase_transaction_idx
  ON purchase (tenant_id, store, transaction_id);

-- 按玩家列自己的购买记录（上游 `ListPurchases` 的走法）。
CREATE INDEX purchase_user_idx ON purchase (tenant_id, user_id, purchase_time);
