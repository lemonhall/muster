-- M9 管理台：控制台用户与审计行（多租户）。
--
-- 与上游形态的差异（见 docs/ecn/ECN-0014-console-and-ops.md）：
--   1. 上游 `console_user` 的主键是 `username`（单租户），这里提到 `(tenant_id, username)`
--      ——ECN-0001 的多租户首列规则，用户名仍然天然唯一（同一租户内）。
--   2. 上游 `acl` 是 jsonb；这里存 TEXT（JSON 文本），因为 D1 没有 jsonb。
--      形状与上游 `acl.ToJson()` 一致：`{"admin":true}` 或 `{"admin":false,"acl":{...30 项}}`。
--   3. 上游把一次性 code 做成控制台 JWT（无状态）；这里在行上存它的哈希与过期时间，
--      因为本项目用 tenant server key 做管理面鉴权、没有控制台签名密钥（偏差 1）。
--   4. 上游的 `audit_log` 是控制台全局的；这里同样按租户分列，`console_audit` 只记
--      控制台用户自身的创建与口令重置（M9 范围内的管理操作）。

CREATE TABLE console_user (
  tenant_id      TEXT    NOT NULL,
  id             TEXT    NOT NULL,
  username       TEXT    NOT NULL,
  email          TEXT    NOT NULL,
  acl            TEXT    NOT NULL,
  mfa_required   INTEGER NOT NULL DEFAULT 0,
  mfa_enabled    INTEGER NOT NULL DEFAULT 0,
  password       TEXT    NOT NULL DEFAULT '',
  password_code  TEXT    NOT NULL DEFAULT '',
  password_code_expiry INTEGER NOT NULL DEFAULT 0,
  create_time    INTEGER NOT NULL,
  update_time    INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, username)
);

-- 按 id 反查（上游控制台把用户 id 放进会话与审计里）。
CREATE INDEX console_user_id_idx ON console_user (tenant_id, id);

-- 控制台审计行。上游 `audit_log` 的列是 (id, user_id, create_time, action, message, metadata)；
-- 这里把"谁做的"记成 `actor_username`（本项目的管理面身份是控制台用户），
-- 并保留 action / message / metadata 三列以对上上游 wire 形状。
CREATE TABLE console_audit (
  tenant_id      TEXT    NOT NULL,
  id             TEXT    NOT NULL,
  actor_username TEXT    NOT NULL DEFAULT '',
  action         TEXT    NOT NULL,
  message        TEXT    NOT NULL DEFAULT '',
  metadata       TEXT    NOT NULL DEFAULT '{}',
  create_time    INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- 审计列表：`WHERE tenant_id = ? ORDER BY create_time DESC, id DESC`。
CREATE INDEX console_audit_time_idx ON console_audit (tenant_id, create_time, id);

-- 请求 ID 关联用的日志表：DoD 8 要求"日志行里带同一个 id"。
-- 上游不需要它（它把日志写 stdout）；Worker 上没有 stdout 可读，所以日志行落在这里，
-- 既是可观测面，也是"响应头与日志同 id"这条断言的落点。
CREATE TABLE request_log (
  tenant_id   TEXT    NOT NULL,
  id          TEXT    NOT NULL,
  request_id  TEXT    NOT NULL,
  method      TEXT    NOT NULL,
  path        TEXT    NOT NULL,
  status      INTEGER NOT NULL,
  create_time INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX request_log_request_id_idx ON request_log (tenant_id, request_id, create_time);
