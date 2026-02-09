# OAuth 2.1 令牌系统实现

## 概述

实现了完整的 OAuth 2.1 令牌系统，包括：
- ✅ 短期访问令牌（1小时）
- ✅ 长期刷新令牌（30天）
- ✅ 令牌轮换（Token Rotation）
- ✅ 令牌撤销端点（RFC 7009）
- ✅ Scope 支持

## 数据库 Schema

### 令牌表

#### 1. access_tokens（访问令牌）
```sql
CREATE TABLE access_tokens (
    token TEXT PRIMARY KEY,           -- 令牌值（32字节随机）
    user_id TEXT NOT NULL,            -- 用户ID
    client_id TEXT NOT NULL,          -- 客户端ID
    scope TEXT NOT NULL DEFAULT 'profile',  -- 权限范围
    expires_at INTEGER NOT NULL,      -- 过期时间（1小时后）
    created_at INTEGER NOT NULL,      -- 创建时间
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES applications(client_id) ON DELETE CASCADE
);
```

#### 2. refresh_tokens（刷新令牌）
```sql
CREATE TABLE refresh_tokens (
    token TEXT PRIMARY KEY,           -- 令牌值（32字节随机）
    user_id TEXT NOT NULL,            -- 用户ID
    client_id TEXT NOT NULL,          -- 客户端ID
    scope TEXT NOT NULL DEFAULT 'profile',  -- 权限范围
    expires_at INTEGER NOT NULL,      -- 过期时间（30天后）
    created_at INTEGER NOT NULL,      -- 创建时间
    last_used_at INTEGER,             -- 最后使用时间
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES applications(client_id) ON DELETE CASCADE
);
```

## API 端点

### 1. 令牌端点（Token Endpoint）

#### 授权码交换（Authorization Code Grant）

**请求：**
```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&
code=AUTHORIZATION_CODE&
client_id=CLIENT_ID&
code_verifier=CODE_VERIFIER&
redirect_uri=REDIRECT_URI
```

**响应：**
```json
{
  "access_token": "短期访问令牌（1小时）",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "长期刷新令牌（30天）",
  "scope": "profile"
}
```

#### 刷新令牌（Refresh Token Grant）

**请求：**
```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&
refresh_token=REFRESH_TOKEN&
client_id=CLIENT_ID
```

**响应：**
```json
{
  "access_token": "新的访问令牌（1小时）",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "新的刷新令牌（30天）",
  "scope": "profile"
}
```

**特性：**
- ✅ 令牌轮换：每次刷新都会生成新的刷新令牌
- ✅ 旧刷新令牌自动失效
- ✅ 防止令牌重放攻击

### 2. 令牌撤销端点（Revocation Endpoint）

**请求：**
```http
POST /oauth/revoke
Content-Type: application/x-www-form-urlencoded

token=TOKEN_TO_REVOKE&
token_type_hint=refresh_token
```

**响应：**
```json
{
  "success": true
}
```

**特性：**
- ✅ 支持撤销访问令牌
- ✅ 支持撤销刷新令牌
- ✅ 撤销刷新令牌时，同时撤销关联的访问令牌
- ✅ 符合 RFC 7009 规范

### 3. UserInfo 端点

**请求：**
```http
GET /oauth/userinfo
Authorization: Bearer ACCESS_TOKEN
```

**变更：**
- 验证短期访问令牌
- 令牌过期后自动失效
- 需要使用刷新令牌获取新的访问令牌

### 4. Discovery 端点

**响应：**
```json
{
  "issuer": "https://id.nightcord.de5.net",
  "authorization_endpoint": "https://id.nightcord.de5.net/oauth/authorize",
  "token_endpoint": "https://id.nightcord.de5.net/oauth/token",
  "userinfo_endpoint": "https://id.nightcord.de5.net/oauth/userinfo",
  "revocation_endpoint": "https://id.nightcord.de5.net/oauth/revoke",
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "revocation_endpoint_auth_methods_supported": ["none"]
}
```

## 令牌管理 API

### 模块：`src/lib/tokens.ts`

#### 1. issueTokens() - 发放令牌
```typescript
const tokens = await issueTokens(db, userId, clientId, scope);
// 返回：{ access_token, token_type, expires_in, refresh_token, scope }
```

#### 2. validateAccessToken() - 验证访问令牌
```typescript
const tokenInfo = await validateAccessToken(db, accessToken);
// 返回：{ userId, clientId, scope, expiresAt } 或 null
```

#### 3. refreshAccessToken() - 刷新访问令牌
```typescript
const newTokens = await refreshAccessToken(db, refreshToken);
// 返回：新的令牌对，包含令牌轮换
```

#### 4. revokeRefreshToken() - 撤销刷新令牌
```typescript
await revokeRefreshToken(db, refreshToken, revokeAccessTokens);
// revokeAccessTokens: 是否同时撤销关联的访问令牌
```

#### 5. revokeAllUserTokens() - 撤销用户所有令牌
```typescript
await revokeAllUserTokens(db, userId, clientId);
// 用于全局登出
```

#### 6. cleanupExpiredTokens() - 清理过期令牌
```typescript
await cleanupExpiredTokens(db);
// 定期清理过期的令牌和授权码
```

## 安全特性

### 1. 短期访问令牌（1小时）

**优势：**
- ✅ 减少令牌泄露风险
- ✅ 限制令牌有效期
- ✅ 符合 OAuth 2.1 最佳实践

**实现：**
```typescript
const accessExpiresAt = Date.now() + 3600 * 1000; // 1小时
```

### 2. 令牌轮换（Token Rotation）

**优势：**
- ✅ 防止刷新令牌重放攻击
- ✅ 每次刷新都生成新令牌
- ✅ 旧令牌自动失效

**实现：**
```typescript
// 删除旧刷新令牌
await db.prepare("DELETE FROM refresh_tokens WHERE token = ?").bind(oldToken).run();

// 插入新刷新令牌
await db.prepare("INSERT INTO refresh_tokens ...").bind(newToken, ...).run();
```

### 3. 令牌撤销

**优势：**
- ✅ 用户可以主动撤销令牌
- ✅ 支持远程登出
- ✅ 符合 RFC 7009

**使用场景：**
- 用户登出
- 设备丢失
- 安全事件响应

### 4. Scope 支持

**优势：**
- ✅ 细粒度权限控制
- ✅ 限制令牌访问范围
- ✅ 符合 OAuth 2.1

**默认 Scope：**
- `profile` - 访问用户基本信息

## 客户端集成

### 完整的 OAuth 2.1 流程

#### 1. 授权请求
```javascript
const codeVerifier = generateCodeVerifier();
const codeChallenge = await generateCodeChallenge(codeVerifier);
const state = generateState();

// 存储 code_verifier 和 state
sessionStorage.setItem('pkce_code_verifier', codeVerifier);
sessionStorage.setItem('oauth_state', state);

// 跳转到授权页面
const authUrl = new URL('https://id.nightcord.de5.net/oauth/authorize');
authUrl.searchParams.set('client_id', 'your_client_id');
authUrl.searchParams.set('redirect_uri', 'https://your-app.com/callback');
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('code_challenge', codeChallenge);
authUrl.searchParams.set('code_challenge_method', 'S256');
authUrl.searchParams.set('state', state);

window.location.href = authUrl.toString();
```

#### 2. 处理回调
```javascript
// 验证 state
const params = new URLSearchParams(window.location.search);
const returnedState = params.get('state');
const storedState = sessionStorage.getItem('oauth_state');

if (returnedState !== storedState) {
  throw new Error('Invalid state - CSRF attack detected');
}

const code = params.get('code');
const codeVerifier = sessionStorage.getItem('pkce_code_verifier');
```

#### 3. 交换令牌
```javascript
const response = await fetch('https://id.nightcord.de5.net/oauth/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    client_id: 'your_client_id',
    code_verifier: codeVerifier,
    redirect_uri: 'https://your-app.com/callback'
  })
});

const tokens = await response.json();
// {
//   access_token: "...",
//   token_type: "Bearer",
//   expires_in: 3600,
//   refresh_token: "...",
//   scope: "profile"
// }

// 存储令牌
localStorage.setItem('access_token', tokens.access_token);
localStorage.setItem('refresh_token', tokens.refresh_token);
localStorage.setItem('token_expires_at', Date.now() + tokens.expires_in * 1000);

// 清理临时数据
sessionStorage.removeItem('pkce_code_verifier');
sessionStorage.removeItem('oauth_state');
```

#### 4. 使用访问令牌
```javascript
const response = await fetch('https://id.nightcord.de5.net/oauth/userinfo', {
  headers: {
    'Authorization': `Bearer ${localStorage.getItem('access_token')}`
  }
});

const user = await response.json();
```

#### 5. 刷新访问令牌
```javascript
async function refreshToken() {
  const refreshToken = localStorage.getItem('refresh_token');

  const response = await fetch('https://id.nightcord.de5.net/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'your_client_id'
    })
  });

  if (!response.ok) {
    // 刷新令牌过期，需要重新登录
    window.location.href = '/login';
    return;
  }

  const tokens = await response.json();

  // 更新令牌
  localStorage.setItem('access_token', tokens.access_token);
  localStorage.setItem('refresh_token', tokens.refresh_token);
  localStorage.setItem('token_expires_at', Date.now() + tokens.expires_in * 1000);
}

// 自动刷新令牌
setInterval(async () => {
  const expiresAt = parseInt(localStorage.getItem('token_expires_at'));
  const now = Date.now();

  // 提前5分钟刷新
  if (expiresAt - now < 5 * 60 * 1000) {
    await refreshToken();
  }
}, 60 * 1000); // 每分钟检查一次
```

#### 6. 撤销令牌（登出）
```javascript
async function logout() {
  const refreshToken = localStorage.getItem('refresh_token');

  // 撤销刷新令牌（同时撤销访问令牌）
  await fetch('https://id.nightcord.de5.net/oauth/revoke', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      token: refreshToken,
      token_type_hint: 'refresh_token'
    })
  });

  // 清除本地令牌
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('token_expires_at');

  // 跳转到登录页
  window.location.href = '/login';
}
```

## 部署步骤

### 1. 数据库 Schema

数据库 schema (`schema.sql`) 包含所有必要的表：
- `access_tokens` - 访问令牌（1小时有效）
- `refresh_tokens` - 刷新令牌（30天有效）
- `auth_codes` - 授权码（包含 scope 字段）

检查表是否存在：

```bash
# 检查本地数据库
npx wrangler d1 execute sekai_pass_db --local --command "
SELECT name FROM sqlite_master WHERE type='table'
AND name IN ('access_tokens', 'refresh_tokens', 'auth_codes');"

# 检查生产数据库
npx wrangler d1 execute sekai_pass_db --remote --command "
SELECT name FROM sqlite_master WHERE type='table'
AND name IN ('access_tokens', 'refresh_tokens', 'auth_codes');"
```

如果表不存在，运行 schema.sql：

```bash
# 本地
npx wrangler d1 execute sekai_pass_db --local --file=./schema.sql

# 生产
npx wrangler d1 execute sekai_pass_db --remote --file=./schema.sql
```

### 2. 部署代码

```bash
npm run deploy
# 或
wrangler deploy
```

### 3. 验证部署

```bash
# 检查 discovery 端点
curl https://id.nightcord.de5.net/.well-known/oauth-authorization-server | jq

# 应该看到：
# - "grant_types_supported": ["authorization_code", "refresh_token"]
# - "revocation_endpoint": "https://id.nightcord.de5.net/oauth/revoke"
```

### 4. 更新客户端

所有 OAuth 客户端需要更新以支持：
- ✅ 存储刷新令牌
- ✅ 实现令牌刷新逻辑
- 处理令牌过期

## 令牌格式

### 访问令牌
- 格式：独立的访问令牌（32字节随机字符串）
- 有效期：1小时
- 用途：访问受保护资源

### 刷新令牌
- 格式：独立的刷新令牌（32字节随机字符串）
- 有效期：30天
- 用途：获取新的访问令牌
- 特性：使用后自动轮换

## 性能考虑

### D1 查询性能

**访问令牌验证：**
```sql
SELECT user_id, client_id, scope, expires_at
FROM access_tokens
WHERE token = ? AND expires_at > ?
```
- 主键查询：极快（<1ms）
- 索引查询：快速（<5ms）

**刷新令牌：**
```sql
SELECT user_id, client_id, scope, expires_at
FROM refresh_tokens
WHERE token = ? AND expires_at > ?
```
- 主键查询：极快（<1ms）

### 令牌清理

**定期清理过期令牌：**
```typescript
// 使用 Cloudflare Cron Triggers
export default {
  async scheduled(event, env, ctx) {
    await cleanupExpiredTokens(env.DB);
  }
}
```

**Cron 配置（wrangler.toml）：**
```toml
[triggers]
crons = ["0 0 * * *"]  # 每天午夜清理
```

## 监控和日志

### 关键指标

1. **令牌发放速率**
   - 监控 `/oauth/token` 端点
   - 检测异常流量

2. **令牌刷新速率**
   - 监控 `grant_type=refresh_token` 请求
   - 检测令牌滥用

3. **令牌撤销速率**
   - 监控 `/oauth/revoke` 端点
   - 检测安全事件

4. **过期令牌数量**
   - 定期统计过期令牌
   - 优化清理策略

### 日志记录

```typescript
// 令牌发放
console.log('Token issued', { userId, clientId, scope });

// 令牌刷新
console.log('Token refreshed', { userId, clientId });

// 令牌撤销
console.log('Token revoked', { tokenType, clientId });
```

## 测试

### 单元测试

```typescript
// 测试令牌发放
test('issueTokens should generate valid tokens', async () => {
  const tokens = await issueTokens(db, 'user123', 'client123', 'profile');
  expect(tokens.access_token).toBeDefined();
  expect(tokens.refresh_token).toBeDefined();
  expect(tokens.expires_in).toBe(3600);
});

// 测试令牌验证
test('validateAccessToken should validate valid token', async () => {
  const tokens = await issueTokens(db, 'user123', 'client123', 'profile');
  const info = await validateAccessToken(db, tokens.access_token);
  expect(info.userId).toBe('user123');
});

// 测试令牌刷新
test('refreshAccessToken should rotate tokens', async () => {
  const tokens1 = await issueTokens(db, 'user123', 'client123', 'profile');
  const tokens2 = await refreshAccessToken(db, tokens1.refresh_token);

  expect(tokens2.access_token).not.toBe(tokens1.access_token);
  expect(tokens2.refresh_token).not.toBe(tokens1.refresh_token);

  // 旧刷新令牌应该失效
  const tokens3 = await refreshAccessToken(db, tokens1.refresh_token);
  expect(tokens3).toBeNull();
});
```

### 集成测试

```bash
# 1. 获取授权码
CODE=$(curl -s "https://id.nightcord.de5.net/oauth/authorize?..." | grep -o 'code=[^&]*' | cut -d= -f2)

# 2. 交换令牌
TOKENS=$(curl -s -X POST https://id.nightcord.de5.net/oauth/token \
  -d "grant_type=authorization_code" \
  -d "code=$CODE" \
  -d "client_id=test" \
  -d "code_verifier=$VERIFIER")

ACCESS_TOKEN=$(echo $TOKENS | jq -r '.access_token')
REFRESH_TOKEN=$(echo $TOKENS | jq -r '.refresh_token')

# 3. 使用访问令牌
curl -H "Authorization: Bearer $ACCESS_TOKEN" \
  https://id.nightcord.de5.net/oauth/userinfo

# 4. 刷新令牌
NEW_TOKENS=$(curl -s -X POST https://id.nightcord.de5.net/oauth/token \
  -d "grant_type=refresh_token" \
  -d "refresh_token=$REFRESH_TOKEN" \
  -d "client_id=test")

# 5. 撤销令牌
curl -X POST https://id.nightcord.de5.net/oauth/revoke \
  -d "token=$REFRESH_TOKEN" \
  -d "token_type_hint=refresh_token"
```

## 相关文件

- `src/lib/tokens.ts` - 令牌管理模块
- `src/index.ts` - OAuth 端点实现
- `schema.sql` - 数据库 schema（包含所有必要的表）
