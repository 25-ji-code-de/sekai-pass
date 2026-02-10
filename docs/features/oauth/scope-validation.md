# OAuth 2.1 Scope 验证中间件

## 概述

实现了完整的 OAuth 2.1 Scope 验证系统，提供细粒度的权限控制。

## 支持的 Scopes

| Scope | 描述 | 权限 |
|-------|------|------|
| `profile` | 基本信息 | 用户名、显示名称、用户ID |
| `email` | 电子邮件 | 用户邮箱地址 |
| `applications` | 应用管理 | 管理 OAuth 应用程序 |
| `admin` | 管理员 | 所有权限（超级权限） |

## 核心功能

### 1. Scope 解析和验证

```typescript
import { parseScopes, validateScopeParameter } from "./lib/scope";

// 解析 scope 字符串
const scopes = parseScopes("profile email");
// 返回: ["profile", "email"]

// 验证 scope 参数
const validation = validateScopeParameter("profile email");
if (!validation.valid) {
  console.error(validation.error);
}
```

### 2. Scope 权限检查

```typescript
import { hasScopes, SCOPES } from "./lib/scope";

// 检查是否拥有所需权限
const granted = "profile email";
const required = [SCOPES.PROFILE, SCOPES.EMAIL];

if (hasScopes(granted, required)) {
  // 用户拥有所需权限
}
```

### 3. 中间件保护端点

```typescript
import { requireScopes, SCOPES } from "./lib/scope";

// 保护需要特定 scope 的端点
app.get("/api/profile", requireScopes([SCOPES.PROFILE]), async (c) => {
  // 只有拥有 profile scope 的令牌才能访问
  const tokenInfo = c.get("tokenInfo");
  return c.json({ userId: tokenInfo.userId });
});

// 需要多个 scopes
app.get("/api/admin/users", requireScopes([SCOPES.ADMIN]), async (c) => {
  // 只有管理员可以访问
});
```

### 4. 数据过滤

```typescript
import { filterUserData } from "./lib/scope";

const user = {
  id: "123",
  username: "alice",
  email: "alice@example.com",
  display_name: "Alice"
};

// 只返回 profile scope 允许的数据
const filtered = filterUserData(user, "profile");
// 返回: { id: "123", username: "alice", display_name: "Alice" }

// 包含 email scope
const filtered2 = filterUserData(user, "profile email");
// 返回: { id: "123", username: "alice", display_name: "Alice", email: "alice@example.com" }
```

## OAuth 流程中的 Scope

### 1. 授权请求

客户端在授权请求中指定所需的 scopes：

```http
GET /oauth/authorize?
  client_id=CLIENT_ID&
  redirect_uri=REDIRECT_URI&
  response_type=code&
  code_challenge=CHALLENGE&
  code_challenge_method=S256&
  state=STATE&
  scope=profile%20email
```

**默认 Scope：** 如果未指定 `scope` 参数，默认为 `profile`。

### 2. 授权页面

用户会看到应用请求的权限列表：

```
授权 MyApp 访问

请求权限：
✓ profile
  访问您的基本信息（用户名、显示名称）

✓ email
  访问您的电子邮件地址
```

### 3. 令牌响应

授权后，令牌响应包含授予的 scopes：

```json
{
  "access_token": "...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "...",
  "scope": "profile email"
}
```

### 4. 使用访问令牌

访问 UserInfo 端点时，返回的数据根据 scope 过滤：

```http
GET /oauth/userinfo
Authorization: Bearer ACCESS_TOKEN
```

**只有 profile scope：**
```json
{
  "id": "123",
  "username": "alice",
  "display_name": "Alice"
}
```

**包含 email scope：**
```json
{
  "id": "123",
  "username": "alice",
  "display_name": "Alice",
  "email": "alice@example.com"
}
```

## API 端点保护示例

### 示例 1：保护用户资料端点

```typescript
import { requireScopes, SCOPES } from "./lib/scope";

// 需要 profile scope
app.get("/api/users/:id", requireScopes([SCOPES.PROFILE]), async (c) => {
  const tokenInfo = c.get("tokenInfo");
  const userId = c.req.param("id");

  // 验证用户只能访问自己的资料
  if (tokenInfo.userId !== userId) {
    return c.json({ error: "forbidden" }, 403);
  }

  const user = await c.env.DB.prepare(
    "SELECT id, username, display_name FROM users WHERE id = ?"
  ).bind(userId).first();

  return c.json(user);
});
```

### 示例 2：保护应用管理端点

```typescript
// 需要 applications scope
app.get("/api/applications", requireScopes([SCOPES.APPLICATIONS]), async (c) => {
  const tokenInfo = c.get("tokenInfo");

  const apps = await c.env.DB.prepare(
    "SELECT * FROM applications WHERE owner_id = ?"
  ).bind(tokenInfo.userId).all();

  return c.json(apps.results);
});

app.post("/api/applications", requireScopes([SCOPES.APPLICATIONS]), async (c) => {
  const tokenInfo = c.get("tokenInfo");
  const { name, redirect_uris } = await c.req.json();

  // 创建新应用
  const clientId = generateId(32);
  await c.env.DB.prepare(
    "INSERT INTO applications (client_id, name, owner_id, redirect_uris) VALUES (?, ?, ?, ?)"
  ).bind(clientId, name, tokenInfo.userId, JSON.stringify(redirect_uris)).run();

  return c.json({ client_id: clientId });
});
```

### 示例 3：管理员端点

```typescript
// 需要 admin scope
app.get("/api/admin/stats", requireScopes([SCOPES.ADMIN]), async (c) => {
  const userCount = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM users"
  ).first();

  const appCount = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM applications"
  ).first();

  return c.json({
    users: userCount.count,
    applications: appCount.count
  });
});
```

## 错误响应

### 401 Unauthorized - 缺少或无效的令牌

```json
{
  "error": "unauthorized",
  "error_description": "Missing or invalid Authorization header"
}
```

```json
{
  "error": "invalid_token",
  "error_description": "Access token is invalid or expired"
}
```

### 403 Forbidden - Scope 不足

```json
{
  "error": "insufficient_scope",
  "error_description": "This endpoint requires scopes: email",
  "scope": "email"
}
```

## 客户端集成

### 请求特定 Scopes

```javascript
// 构建授权 URL
const authUrl = new URL('https://id.nightcord.de5.net/oauth/authorize');
authUrl.searchParams.set('client_id', 'your_client_id');
authUrl.searchParams.set('redirect_uri', 'https://your-app.com/callback');
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('code_challenge', codeChallenge);
authUrl.searchParams.set('code_challenge_method', 'S256');
authUrl.searchParams.set('state', state);
authUrl.searchParams.set('scope', 'profile email'); // 请求多个 scopes

window.location.href = authUrl.toString();
```

### 检查授予的 Scopes

```javascript
// 交换令牌后
const tokens = await response.json();
console.log('Granted scopes:', tokens.scope);

// 检查是否拥有特定 scope
const hasEmailScope = tokens.scope.split(' ').includes('email');
if (hasEmailScope) {
  // 可以访问用户邮箱
}
```

### 处理 Scope 不足错误

```javascript
async function fetchUserProfile() {
  const response = await fetch('https://id.nightcord.de5.net/oauth/userinfo', {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  if (response.status === 403) {
    const error = await response.json();
    if (error.error === 'insufficient_scope') {
      // 需要重新授权以获取更多权限
      console.log('Required scopes:', error.scope);
      // 重定向到授权页面，请求所需的 scopes
      redirectToAuthorize(error.scope);
    }
  }

  return response.json();
}
```

## Admin Scope 特殊规则

`admin` scope 是一个特殊的超级权限：

- ✅ 拥有 `admin` scope 的令牌可以访问所有端点
- ✅ 自动满足所有 scope 要求
- ⚠️ 应该非常谨慎地授予此权限
- ⚠️ 建议只在内部管理工具中使用

```typescript
// admin scope 可以访问任何端点
const granted = "admin";
hasScopes(granted, [SCOPES.PROFILE]); // true
hasScopes(granted, [SCOPES.EMAIL]); // true
hasScopes(granted, [SCOPES.APPLICATIONS]); // true
```

## 最佳实践

### 1. 最小权限原则

只请求应用实际需要的 scopes：

```javascript
// ❌ 不好：请求所有权限
scope: 'profile email applications admin'

// ✅ 好：只请求需要的权限
scope: 'profile'
```

### 2. 渐进式权限请求

在需要时才请求额外权限：

```javascript
// 初始登录：只请求基本信息
scope: 'profile'

// 用户想要接收邮件通知时，再请求 email scope
scope: 'profile email'
```

### 3. 清晰的权限说明

在授权页面清楚地说明每个 scope 的用途：

```typescript
export const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  [SCOPES.PROFILE]: "访问您的基本信息（用户名、显示名称）",
  [SCOPES.EMAIL]: "访问您的电子邮件地址",
  [SCOPES.APPLICATIONS]: "管理您的 OAuth 应用程序",
  [SCOPES.ADMIN]: "管理员权限"
};
```

### 4. 验证 Scope 参数

始终验证客户端请求的 scopes：

```typescript
const scopeValidation = validateScopeParameter(scopeParam);
if (!scopeValidation.valid) {
  return c.json({ error: "invalid_scope", error_description: scopeValidation.error }, 400);
}
```

## Discovery 端点更新

Discovery 端点现在包含支持的 scopes：

```http
GET /.well-known/oauth-authorization-server
```

```json
{
  "issuer": "https://id.nightcord.de5.net",
  "authorization_endpoint": "https://id.nightcord.de5.net/oauth/authorize",
  "token_endpoint": "https://id.nightcord.de5.net/oauth/token",
  "userinfo_endpoint": "https://id.nightcord.de5.net/oauth/userinfo",
  "revocation_endpoint": "https://id.nightcord.de5.net/oauth/revoke",
  "scopes_supported": ["profile", "email", "applications", "admin"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  ...
}
```

## 数据库 Schema

Scope 信息存储在以下表中：

```sql
-- auth_codes 表
CREATE TABLE auth_codes (
  ...
  scope TEXT DEFAULT 'profile',
  ...
);

-- access_tokens 表
CREATE TABLE access_tokens (
  ...
  scope TEXT NOT NULL DEFAULT 'profile',
  ...
);

-- refresh_tokens 表
CREATE TABLE refresh_tokens (
  ...
  scope TEXT NOT NULL DEFAULT 'profile',
  ...
);
```

## 测试

### 测试 Scope 验证

```bash
# 1. 获取只有 profile scope 的令牌
curl -X POST https://id.nightcord.de5.net/oauth/token \
  -d "grant_type=authorization_code" \
  -d "code=$CODE" \
  -d "client_id=test" \
  -d "code_verifier=$VERIFIER"

# 2. 访问 UserInfo（应该只返回 profile 数据）
curl -H "Authorization: Bearer $ACCESS_TOKEN" \
  https://id.nightcord.de5.net/oauth/userinfo

# 3. 尝试访问需要 email scope 的端点（应该返回 403）
curl -H "Authorization: Bearer $ACCESS_TOKEN" \
  https://id.nightcord.de5.net/api/user/email
```

### 测试无效 Scope

```bash
# 请求无效的 scope
curl "https://id.nightcord.de5.net/oauth/authorize?\
client_id=test&\
redirect_uri=http://localhost:3000/callback&\
response_type=code&\
scope=invalid_scope"

# 应该返回 400 Bad Request
```

## OAuth 2.1 合规性

Scope 验证功能确保了 OAuth 2.1 合规性：

| 功能 | 状态 |
|------|------|
| Scope 参数支持 | ✅ |
| Scope 验证 | ✅ |
| 基于 Scope 的访问控制 | ✅ |
| Scope 过滤用户数据 | ✅ |
| Discovery 端点包含 scopes_supported | ✅ |

## 相关文件

- `src/lib/scope.ts` - Scope 验证模块
- `src/index.ts` - OAuth 端点
- `src/lib/html.ts` - 授权页面
- `src/lib/api.ts` - API 路由
