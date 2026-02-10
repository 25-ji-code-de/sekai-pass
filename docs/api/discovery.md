# OAuth/OIDC Discovery 端点

SEKAI Pass 支持 OAuth 2.0 授权服务器元数据（RFC 8414）和 OpenID Connect Discovery。客户端可以自动发现配置。

## Discovery 端点

### 标准 Discovery 端点
```
GET /.well-known/oauth-authorization-server
```

**响应示例：**
```json
{
  "issuer": "https://id.nightcord.de5.net",
  "authorization_endpoint": "https://id.nightcord.de5.net/oauth/authorize",
  "token_endpoint": "https://id.nightcord.de5.net/oauth/token",
  "userinfo_endpoint": "https://id.nightcord.de5.net/oauth/userinfo",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code"],
  "code_challenge_methods_supported": ["S256", "plain"],
  "token_endpoint_auth_methods_supported": ["client_secret_post", "none"],
  "service_documentation": "https://id.nightcord.de5.net/docs",
  "ui_locales_supported": ["zh-CN", "en-US"]
}
```

### 简化版 API 端点
```
GET /api/oauth/config
```

**响应示例：**
```json
{
  "authorization_endpoint": "https://id.nightcord.de5.net/oauth/authorize",
  "token_endpoint": "https://id.nightcord.de5.net/oauth/token",
  "userinfo_endpoint": "https://id.nightcord.de5.net/oauth/userinfo",
  "pkce_supported": true,
  "code_challenge_methods": ["S256", "plain"]
}
```

## 使用场景

### 1. 自动配置 OAuth 客户端

许多 OAuth 库支持自动发现配置：

**JavaScript 示例：**
```javascript
// 使用 oauth4webapi
import * as oauth from 'oauth4webapi';

const issuer = new URL('https://id.nightcord.de5.net');
const as = await oauth
  .discoveryRequest(issuer)
  .then((response) => oauth.processDiscoveryResponse(issuer, response));

console.log(as.authorization_endpoint);
// => https://id.nightcord.de5.net/oauth/authorize
```

**Python 示例：**
```python
from authlib.integrations.requests_client import OAuth2Session

client = OAuth2Session(
    client_id='your_client_id',
    redirect_uri='https://your-app.com/callback'
)

# 自动发现配置
client.fetch_server_metadata(
    'https://id.nightcord.de5.net/.well-known/oauth-authorization-server'
)

# 现在可以直接使用
authorization_url, state = client.create_authorization_url()
```

### 2. 验证服务器配置

开发者可以快速检查 SEKAI Pass 支持哪些功能：

```bash
curl https://id.nightcord.de5.net/.well-known/oauth-authorization-server | jq
```

### 3. 动态更新端点

如果 SEKAI Pass 的端点 URL 发生变化，客户端可以自动适配。

## 支持的功能

| 功能 | 支持 | 说明 |
|------|------|------|
| Authorization Code Flow | ✅ | 标准授权码流程 |
| PKCE (S256) | ✅ | 所有客户端强制使用 |
| PKCE (plain) | ✅ | 不推荐，仅用于兼容性 |
| Public Client | ✅ | 用于 SPA 和移动应用 |
| Refresh Token | ✅ | 30天有效期 |
| Scope | ✅ | openid, profile, email, applications, admin |
| Token Revocation | ✅ | RFC 7009 |
| OpenID Connect | ✅ | OIDC 1.0 |

## 测试

### 测试 Discovery 端点

```bash
# 标准端点
curl https://id.nightcord.de5.net/.well-known/oauth-authorization-server

# 简化端点
curl https://id.nightcord.de5.net/api/oauth/config
```

### 验证响应

确保响应包含：
- ✅ `authorization_endpoint`
- ✅ `token_endpoint`
- ✅ `userinfo_endpoint`
- ✅ `code_challenge_methods_supported` 包含 "S256"
