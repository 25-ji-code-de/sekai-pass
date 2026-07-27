-- SEKAI Pass — 开放平台所需的增量迁移
--
-- schema.sql 用的是 CREATE TABLE IF NOT EXISTS，对**已存在**的表不会补列，
-- 所以线上库必须跑这份增量。
--
-- 应用方式：
--   npm run migrate -- --remote
--
-- **不要直接 `wrangler d1 execute --file` 跑这个文件。** 下面第 2 节的
-- ALTER TABLE 只能干净地跑一次：SQLite 没有 ADD COLUMN IF NOT EXISTS，
-- 第二次会在第一条上以 `duplicate column name` 中止，且后面的语句一条都不执行。
-- 于是「不确定库是什么状态，重跑一遍确认」这个再自然不过的动作会拿到一个
-- 分不清是「已经迁过了」还是「真坏了」的报错；迁移中途失败时更是只能手工补列。
--
-- scripts/migrate.mjs 会先读 pragma_table_info 看哪几列已经在了，只补缺的那几列，
-- 跑几遍、从任意中断点接着跑，结果都一样。加新列时只改这个文件，脚本不用动。
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
-- D1（SQLite）不支持 ADD COLUMN IF NOT EXISTS，所以这几条是整个文件里
-- 唯一不能重复执行的部分 —— scripts/migrate.mjs 正是靠先查 pragma_table_info
-- 来跳过已有的列。它按 `ALTER TABLE <表> ADD COLUMN <列>` 这个形状解析本文件，
-- 加新列照着这个写法即可。

ALTER TABLE applications ADD COLUMN owner_user_id TEXT;
ALTER TABLE applications ADD COLUMN token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none';
ALTER TABLE applications ADD COLUMN description TEXT;
ALTER TABLE applications ADD COLUMN homepage_url TEXT;
ALTER TABLE applications ADD COLUMN updated_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_applications_owner ON applications(owner_user_id);

-- ── 3. 存量数据 ───────────────────────────────────────────────────
--
-- 平台上线前手工插入的应用没有 owner_user_id，在开放平台里看不见也改不了。
-- （`npm run migrate` 跑完会把这样的应用列出来提醒你。）
-- 认领方式（把 <你的 user id> 换成实际值）：
--
--   UPDATE applications SET owner_user_id = '<你的 user id>'
--   WHERE owner_user_id IS NULL;
--
-- 查自己的 user id：
--   SELECT id, username FROM users WHERE username = '<你的用户名>';
--
-- 这一步**故意不自动执行** —— 把所有存量应用划给某个人是需要你确认的决定。
