-- M1 身份与账号的权威库结构（多租户，见 docs/ecn/ECN-0001-multi-tenancy.md）。
--
-- 租户（tenant）= 一个游戏。同一部署内并行运营多个游戏，彼此数据完全隔离：
-- 每一张业务表都带 tenant_id，且**所有查询都必须带租户条件**（没有"默认租户"回退）。
--
-- 与上游的形态差异（内部存储细节，不影响对外可观测行为）：
--   1. 上游把它拆成 users + user_device + user_email + user_custom ... 多张表；
--      我们合成一张 user_identity（provider 判别列）。
--   2. 上游没有租户概念（一套部署一个游戏），我们用 tenant_id 把"每个游戏内唯一"
--      这个语义显式化：用户名与邮箱在**租户内**唯一。
--   3. 时间列统一存 Unix 秒（INTEGER）。上游用 timestamptz，REST 面输出 RFC3339；
--      转换发生在 wire 层，对外形状一致。

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- 只存 server key 的 SHA-256；明文永不落库（创建时一次性打印给运营者）。
  server_key_hash TEXT NOT NULL UNIQUE,
  create_time INTEGER NOT NULL,
  disable_time INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE users (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  lang_tag TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  email TEXT,
  password_hash TEXT,
  verify_time INTEGER NOT NULL DEFAULT 0,
  disable_time INTEGER NOT NULL DEFAULT 0,
  create_time INTEGER NOT NULL,
  update_time INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, username),
  UNIQUE (tenant_id, email)
);

-- 一个用户可以在同一 provider 下挂多个身份（上游允许一个用户有多台设备）。
CREATE TABLE user_identity (
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, provider, provider_id)
);

CREATE INDEX user_identity_user_idx ON user_identity (tenant_id, user_id);

-- 会话登记表：Bearer 令牌除签名校验外，还必须在这里"活着"（对应上游 sessionCache）。
-- 登出 = 把 revoked_at 写上，之后同一 token_id 立即失效。
CREATE TABLE sessions (
  token_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  exp INTEGER NOT NULL,
  refresh_exp INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX sessions_user_idx ON sessions (tenant_id, user_id);
