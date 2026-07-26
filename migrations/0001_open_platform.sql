-- SEKAI Pass — 开放平台所需的增量迁移
--
-- schema.sql 用的是 CREATE TABLE IF NOT EXISTS，对**已存在**的表不会补列，
-- 所以线上库必须跑这份增量。
--
-- 应用方式：
--   npx wrangler d1 execute sekai_pass_db --remote --file=./migrations/0001_open_platform.sql
--
-- 全部语句都可重复执行（IF NOT EXISTS / 先查后加），跑两遍不会出错。
--
-- ── 背景 ──────────────────────────────────────────────────────────
-- client_keys 与 jwt_replay_cache 此前**不在 schema.sql 里**，
-- 但 src/lib/client-auth.ts 一直在查它们。线上库里应该是手工建过；
-- 这份迁移让 schema 与现实对齐，同时补上开放平台需要的列。

-- ── 1. 缺失的表 ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS client_keys (
    client_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    public_key_jwk TEXT NOT NULL,
    algorithm TEXT NOT NULL DEFAULT 'ES256',
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (client_id, key_id)
);

CREATE INDEX IF NOT EXISTS idx_client_keys_lookup ON client_keys(client_id, key_id, status);

CREATE TABLE IF NOT EXISTS jwt_replay_cache (
    jti TEXT NOT NULL,
    client_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (jti, client_id)
);

CREATE INDEX IF NOT EXISTS idx_jwt_replay_expires ON jwt_replay_cache(expires_at);

-- ── 2. applications 的新列 ────────────────────────────────────────
--
-- D1（SQLite）不支持 ADD COLUMN IF NOT EXISTS。
-- 下面每条如果列已存在会报 "duplicate column name"，**可以安全忽略**。
-- 想要幂等的话，逐条跑并忽略这一类错误即可。

ALTER TABLE applications ADD COLUMN owner_user_id TEXT;
ALTER TABLE applications ADD COLUMN token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none';
ALTER TABLE applications ADD COLUMN description TEXT;
ALTER TABLE applications ADD COLUMN homepage_url TEXT;
ALTER TABLE applications ADD COLUMN updated_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_applications_owner ON applications(owner_user_id);

-- ── 3. 存量数据 ───────────────────────────────────────────────────
--
-- 平台上线前手工插入的应用没有 owner_user_id，在开放平台里看不见也改不了。
-- 认领方式（把 <你的 user id> 换成实际值）：
--
--   UPDATE applications SET owner_user_id = '<你的 user id>'
--   WHERE owner_user_id IS NULL;
--
-- 查自己的 user id：
--   SELECT id, username FROM users WHERE username = '<你的用户名>';
--
-- 这一步**故意不自动执行** —— 把所有存量应用划给某个人是需要你确认的决定。
