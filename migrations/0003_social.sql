-- M5 社交图：好友边、群组、群组成员边、通知（多租户）。
--
-- 与上游的形态差异（内部存储细节，见 docs/ecn/ECN-0008-social-graph-on-d1.md）：
--   1. 上游 `user_edge` / `groups` / `group_edge` / `notification` 四张表没有租户列；
--      这里每张表都把 tenant_id 放在主键首列，"每个游戏内一份社交图"在库结构里显式。
--   2. 上游用 UUID 类型 + timestamptz；这里统一 TEXT（大写标准形）+ Unix 秒。
--      UUID 的十六进制文本比较与字节比较同序，所以 `ORDER BY id` 的语义保持一致。
--   3. 上游用 `disable_time` 做软删除（查询到处带 `disable_time = epoch`）；这里删除即删行，
--      因为本项目没有"控制台需要看到已删群组"这条需求（M9 再评估）。
--   4. 上游 `users.edge_count` 是一列（社交边 + 群组边的合计），这里补在 users 上（ALTER）。

-- 好友边：**双向两行**（与上游同构）。state 取值 0 FRIEND / 1 INVITE_SENT /
-- 2 INVITE_RECEIVED / 3 BLOCKED。position 是"关系建立时刻的纳秒"，列表按
-- (state, position) 升序，游标也按这两列定位。
CREATE TABLE user_edge (
  tenant_id      TEXT    NOT NULL,
  source_id      TEXT    NOT NULL,
  destination_id TEXT    NOT NULL,
  state          INTEGER NOT NULL,
  position       INTEGER NOT NULL,
  update_time    INTEGER NOT NULL,
  metadata       TEXT    NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, source_id, destination_id)
);

-- 好友列表：`WHERE tenant_id = ? AND source_id = ? [AND state = ?] ORDER BY state, position`。
CREATE INDEX user_edge_list_idx ON user_edge (tenant_id, source_id, state, position);

-- 反向边与"好友的好友"：`WHERE tenant_id = ? AND source_id = ? AND state = 0 ORDER BY destination_id`。
CREATE INDEX user_edge_friends_idx ON user_edge (tenant_id, source_id, state, destination_id);

-- 群组。open 是布尔（1 开放、0 私有），对应上游 groups.state（0 开放 / 1 私有）的取反。
-- 名字在**租户内**唯一（上游是全局唯一，见 ECN-0001）。
CREATE TABLE groups (
  tenant_id   TEXT    NOT NULL,
  id          TEXT    NOT NULL,
  creator_id  TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  avatar_url  TEXT    NOT NULL DEFAULT '',
  lang_tag    TEXT    NOT NULL DEFAULT '',
  metadata    TEXT    NOT NULL DEFAULT '{}',
  open        INTEGER NOT NULL DEFAULT 1,
  edge_count  INTEGER NOT NULL DEFAULT 1,
  max_count   INTEGER NOT NULL DEFAULT 100,
  create_time INTEGER NOT NULL,
  update_time INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name)
);

-- 群组列表的三条排序路径（lang/edge/open 组合）；与 src/domain/groups/store.ts 的
-- 查询形态一一对应。
CREATE INDEX groups_lang_idx ON groups (tenant_id, lang_tag, edge_count, id);
CREATE INDEX groups_edge_idx ON groups (tenant_id, edge_count, update_time, id);
CREATE INDEX groups_open_idx ON groups (tenant_id, open, lang_tag, edge_count, id);
CREATE INDEX groups_update_idx ON groups (tenant_id, update_time, edge_count, id);
CREATE INDEX groups_name_idx ON groups (tenant_id, name);

-- 群组成员边：**双向两行**，与上游同构。上游 `core_group.go::groupAddUser` 一次
-- 插入 `(position, state, group_id, user_id)` 与 `(position, state, user_id, group_id)`
-- 两行（同 position、同 state），于是"某个群有哪些成员"（source = 群组）与
-- "某个用户在哪些群里"（source = 用户）用的是同一张表的两半。
--
-- 唯一的例外是**封禁**：上游 `BanGroupUsers` 先删双向两行，再插**一行**
-- `group_id -> user_id, state = 4`，所以被封禁的用户不会在自己的群列表里看到这个群，
-- 但群成员列表按 state=4 过滤时能看到他。
--
-- state 取值 0 SUPERADMIN / 1 ADMIN / 2 MEMBER / 3 JOIN_REQUEST / 4 BANNED。
CREATE TABLE group_edge (
  tenant_id      TEXT    NOT NULL,
  source_id      TEXT    NOT NULL,
  destination_id TEXT    NOT NULL,
  state          INTEGER NOT NULL,
  position       INTEGER NOT NULL,
  update_time    INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, source_id, destination_id)
);

-- 群成员列表（source = 群组）与用户群组列表（source = 用户）都按
-- `WHERE tenant_id = ? AND source_id = ? ORDER BY state, position` 取数，
-- 所以一条索引同时服务两条查询（两边都补 (tenant_id, source_id, state, position) 只是白写）。
CREATE INDEX group_edge_members_idx ON group_edge (tenant_id, source_id, state, position);

-- 通知。code 为负数是上游的内置类别（-1 DM 请求 / -2 好友请求 / -3 好友接受 /
-- -4 加入群组 / -5 群组加入申请 / -6 好友开局 / -7 单 socket / -8 封禁 / -9 解除好友）。
CREATE TABLE notifications (
  tenant_id   TEXT    NOT NULL,
  id          TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  subject     TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  code        INTEGER NOT NULL,
  sender_id   TEXT    NOT NULL DEFAULT '',
  create_time INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- 通知列表：`WHERE tenant_id = ? AND user_id = ? ORDER BY create_time, id`。
CREATE INDEX notifications_user_idx ON notifications (tenant_id, user_id, create_time, id);

-- 上游 `users.edge_count` 是社交边（好友 + 群组）的计数。列存在即可，默认 0。
ALTER TABLE users ADD COLUMN edge_count INTEGER NOT NULL DEFAULT 0;
