-- Users table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    hashed_password TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    bio TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- OAuth accounts table (for future OAuth integration)
CREATE TABLE IF NOT EXISTS oauth_accounts (
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (provider, provider_user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Applications table (for SSO clients)
CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    client_id TEXT NOT NULL UNIQUE,
    client_secret TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    -- 归属：谁创建的这个应用。开放平台按它做权限隔离。
    -- 允许为 NULL —— 平台上线前手工插入的应用没有归属，需要人工认领。
    owner_user_id TEXT,
    -- none = 公开客户端（靠 PKCE 保护）；private_key_jwt = 机密客户端（RFC 7523）
    token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
    description TEXT,
    homepage_url TEXT,
    updated_at INTEGER,
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_applications_owner ON applications(owner_user_id);

-- Client public keys for private_key_jwt (RFC 7523)
--
-- 注意：这张表与下面的 jwt_replay_cache 此前**不在 schema 里**，
-- 但 src/lib/client-auth.ts 一直在查它们。也就是说照本文件全新部署出来的
-- 实例，private_key_jwt 客户端认证会直接不可用。
CREATE TABLE IF NOT EXISTS client_keys (
    client_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    public_key_jwk TEXT NOT NULL,
    algorithm TEXT NOT NULL DEFAULT 'ES256',
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (client_id, key_id),
    FOREIGN KEY (client_id) REFERENCES applications(client_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_client_keys_lookup ON client_keys(client_id, key_id, status);

-- JWT assertion 防重放（RFC 7523 的 jti 只能用一次）
CREATE TABLE IF NOT EXISTS jwt_replay_cache (
    jti TEXT NOT NULL,
    client_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (jti, client_id)
);

CREATE INDEX IF NOT EXISTS idx_jwt_replay_expires ON jwt_replay_cache(expires_at);

-- Authorization codes table
CREATE TABLE IF NOT EXISTS auth_codes (
    code TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    code_challenge TEXT,
    code_challenge_method TEXT DEFAULT 'S256',
    state TEXT,
    scope TEXT DEFAULT 'profile',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- OAuth access tokens table (short-lived, 1 hour)
CREATE TABLE IF NOT EXISTS access_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'profile',
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES applications(client_id) ON DELETE CASCADE
);

-- OAuth refresh tokens table (long-lived, 30 days)
CREATE TABLE IF NOT EXISTS refresh_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'profile',
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES applications(client_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user_id ON oauth_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_codes_user_id ON auth_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_access_tokens_user_id ON access_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_access_tokens_expires_at ON access_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);

-- Signing keys for OIDC ID tokens
-- Used to sign and verify ID tokens (JWT)
CREATE TABLE IF NOT EXISTS signing_keys (
    kid TEXT PRIMARY KEY,
    public_key_jwk TEXT NOT NULL,
    private_key_jwk TEXT NOT NULL,  -- Encrypted with AES-256-GCM
    algorithm TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active'
);

-- OIDC authentication data
-- Stores nonce and auth_time for OIDC flows
CREATE TABLE IF NOT EXISTS oidc_auth_data (
    code TEXT PRIMARY KEY,
    nonce TEXT,
    auth_time INTEGER NOT NULL,
    FOREIGN KEY (code) REFERENCES auth_codes(code) ON DELETE CASCADE
);
