# OpenID Connect (OIDC) 实现文档

## 概述

SEKAI Pass 支持 OpenID Connect 1.0，在 OAuth 2.1 之上提供标准化的身份层。这使得可以为认证用例颁发 ID token，允许客户端应用通过签名的 JWT 令牌验证用户身份。

## 功能特性

- **ES256 签名**: 使用 P-256 曲线的 ECDSA 和 SHA-256 进行 JWT 签名
- **自动密钥轮换**: 密钥每 90 天轮换一次，有 7 天宽限期
- **JWKS 端点**: 发布公钥用于令牌验证
- **Discovery 端点**: 完整的 OIDC discovery 元数据
- **向后兼容**: 现有 OAuth 2.1 客户端继续正常工作
- **Nonce 支持**: 防止重放攻击
- **基于 Scope 的声明**: 根据请求的 scope 包含声明

## 架构

### JWT 签名 (ES256)

- **算法**: 使用 P-256 曲线的 ECDSA 和 SHA-256
- **密钥大小**: 256 位（相当于 RSA-2048 安全性）
- **签名大小**: ~512 位（比 RSA 小）
- **性能**: 使用 Web Crypto API 每个令牌约 1-2ms

### 密钥管理

**存储：**
- 主存储: Cloudflare Workers KV（快速读取访问）
- 备份: D1 数据库（持久化和审计跟踪）
- 格式: JWK (JSON Web Key)
- 加密: 私钥使用 AES-256-GCM 加密

**轮换：**
- 自动: 每 90 天通过 cron 触发器
- 宽限期: 7 天（旧密钥在验证时仍然有效）
- 手动: 紧急轮换的管理 API 端点

### 数据库架构

OIDC 相关数据使用 `schema.sql` 中的 OAuth 表存储：

- `auth_codes` 表的 `scope` 字段用于 OIDC scope
- `access_tokens` 和 `refresh_tokens` 用于令牌管理
- KV 命名空间用于签名密钥缓存
- D1 数据库用于密钥持久化

OIDC 特定数据（nonce、auth_time）从现有 OAuth 数据派生。

## 端点

### Discovery 端点

**GET** `/.well-known/openid-configuration`

返回 OIDC discovery 元数据：

```json
{
  "issuer": "https://id.nightcord.de5.net",
  "authorization_endpoint": "https://id.nightcord.de5.net/oauth/authorize",
  "token_endpoint": "https://id.nightcord.de5.net/oauth/token",
  "userinfo_endpoint": "https://id.nightcord.de5.net/oauth/userinfo",
  "jwks_uri": "https://id.nightcord.de5.net/.well-known/jwks.json",
  "revocation_endpoint": "https://id.nightcord.de5.net/oauth/revoke",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["ES256"],
  "scopes_supported": ["openid", "profile", "email", "applications", "admin"],
  "token_endpoint_auth_methods_supported": ["none"],
  "claims_supported": [
    "sub", "iss", "aud", "exp", "iat", "auth_time", "nonce",
    "name", "preferred_username", "email", "email_verified"
  ],
  "code_challenge_methods_supported": ["S256", "plain"]
}
```

### JWKS 端点

**GET** `/.well-known/jwks.json`

返回用于 JWT 验证的公钥：

```json
{
  "keys": [
    {
      "kty": "EC",
      "use": "sig",
      "crv": "P-256",
      "kid": "abc123...",
      "x": "...",
      "y": "...",
      "alg": "ES256"
    }
  ]
}
```

**Cache-Control**: `public, max-age=3600` (1 小时)

## OIDC 流程

### 1. 授权请求

在授权请求中包含 `openid` scope：

```
GET /oauth/authorize?
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://your-app.com/callback&
  response_type=code&
  scope=openid%20profile%20email&
  code_challenge=CHALLENGE&
  code_challenge_method=S256&
  state=STATE&
  nonce=NONCE
```

**参数：**
- `scope`: 必须包含 `openid` 才能使用 OIDC
- `nonce`: 可选但推荐用于重放保护

### 2. 令牌交换

使用授权码交换令牌：

```bash
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&
code=AUTH_CODE&
client_id=YOUR_CLIENT_ID&
code_verifier=VERIFIER
```

**响应：**

```json
{
  "access_token": "...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "...",
  "scope": "openid profile email",
  "id_token": "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImFiYzEyMyJ9..."
}
```

### 3. ID Token 结构

```json
{
  "header": {
    "alg": "ES256",
    "typ": "JWT",
    "kid": "abc123..."
  },
  "payload": {
    "iss": "https://id.nightcord.de5.net",
    "sub": "user_id",
    "aud": "client_id",
    "exp": 1234567890,
    "iat": 1234567890,
    "auth_time": 1234567890,
    "nonce": "random_nonce",
    "name": "Display Name",
    "preferred_username": "username",
    "email": "user@example.com",
    "email_verified": true,
    "acr": "urn:mace:incommon:iap:silver",
    "amr": ["pwd"]
  }
}
```

### 4. 令牌验证

客户端应验证 ID token：

1. 从 JWKS 端点获取公钥
2. 使用公钥验证 JWT 签名
3. 验证声明：
   - `iss` 匹配预期的颁发者
   - `aud` 匹配客户端 ID
   - `exp` 在未来
   - `iat` 不在未来
   - `nonce` 匹配请求（如果提供）

## Scope 和声明

### Scope

- `openid`: OIDC 必需，启用 ID token 颁发
- `profile`: 添加 `name`、`preferred_username` 声明
- `email`: 添加 `email`、`email_verified` 声明
- `applications`: OAuth 应用管理（无 ID token 声明）
- `admin`: 管理访问（无 ID token 声明）

### 声明映射

| Scope | 声明 |
|-------|--------|
| `openid` | `sub`, `iss`, `aud`, `exp`, `iat`, `auth_time` |
| `profile` | `name`, `preferred_username` |
| `email` | `email`, `email_verified` |

## 安全考虑

### 私钥保护

- 私钥使用 AES-256-GCM 加密
- 加密密钥存储在 Workers Secret 中
- 永不通过 API 暴露
- 在 KV 中缓存以提高性能

### Nonce 验证

- 每个授权码存储
- 包含在 ID token 中
- 防止重放攻击
- 由客户端验证

### 密钥轮换

- 自动 90 天轮换
- 验证有 7 天宽限期
- 宽限期内旧密钥保留在 JWKS 中
- 数据库中的审计跟踪

### 令牌过期

- ID token 1 小时后过期
- 与访问令牌相同的生命周期
- 刷新时不颁发（按 OIDC 规范）
- 客户端必须使用刷新令牌获取新访问权限

## 设置说明

### 1. 创建 KV 命名空间

```bash
wrangler kv:namespace create "OIDC_KEYS"
wrangler kv:namespace create "OIDC_KEYS" --preview
```

在 `wrangler.toml` 中更新命名空间 ID。

### 2. 设置加密密钥

```bash
# 生成随机密钥
openssl rand -hex 32

# 设置 secret
wrangler secret put KEY_ENCRYPTION_SECRET
```

### 3. 部署

```bash
wrangler deploy
```

### 4. 验证设置

```bash
# 测试 discovery
curl https://your-domain/.well-known/openid-configuration | jq

# 测试 JWKS
curl https://your-domain/.well-known/jwks.json | jq
```

## 客户端集成

### Node.js 示例

```javascript
const { Issuer, generators } = require('openid-client');

// 发现 OIDC 配置
const issuer = await Issuer.discover('https://id.nightcord.de5.net');

// 创建客户端
const client = new issuer.Client({
  client_id: 'YOUR_CLIENT_ID',
  redirect_uris: ['https://your-app.com/callback'],
  response_types: ['code'],
});

// 生成 PKCE 和 nonce
const code_verifier = generators.codeVerifier();
const code_challenge = generators.codeChallenge(code_verifier);
const nonce = generators.nonce();

// 授权 URL
const authUrl = client.authorizationUrl({
  scope: 'openid profile email',
  code_challenge,
  code_challenge_method: 'S256',
  nonce,
});

// 令牌交换
const tokenSet = await client.callback(
  'https://your-app.com/callback',
  { code: 'AUTH_CODE' },
  { code_verifier, nonce }
);

// 访问 ID token
console.log(tokenSet.id_token);
console.log(tokenSet.claims());
```

### 浏览器示例

```javascript
// 使用 oidc-client-ts 库
import { UserManager } from 'oidc-client-ts';

const userManager = new UserManager({
  authority: 'https://id.nightcord.de5.net',
  client_id: 'YOUR_CLIENT_ID',
  redirect_uri: 'https://your-app.com/callback',
  response_type: 'code',
  scope: 'openid profile email',
});

// 登录
await userManager.signinRedirect();

// 处理回调
const user = await userManager.signinRedirectCallback();
console.log(user.id_token);
console.log(user.profile);
```

## 故障排查

### 无可用签名密钥

**错误**: "No signing key available"

**解决方案**: 密钥在首次使用时生成。向 JWKS 端点发出请求以触发密钥生成：

```bash
curl https://your-domain/.well-known/jwks.json
```

### 签名无效

**错误**: "Invalid signature"

**原因**:
- 服务器之间的时钟偏差
- 使用错误的公钥
- 密钥轮换进行中

**解决方案**:
- 从 JWKS 端点获取最新密钥
- 检查系统时间同步
- 使用更新的密钥重试

### 缺少 id_token

**错误**: 令牌响应中没有 `id_token`

**原因**:
- 未请求 `openid` scope
- 授权请求缺少 scope 参数

**解决方案**: 在 scope 参数中包含 `openid`：
```
scope=openid profile email
```

## 监控

### 密钥轮换

密钥每周日午夜（UTC）自动轮换。监控：

- `signing_keys` 表中的密钥创建
- KV 缓存更新
- 宽限期内 JWKS 端点返回多个密钥

### 令牌颁发

监控 ID token 生成：

- 检查 `oidc_auth_data` 表中的 OIDC 请求
- 验证令牌响应中的 `id_token` 字段
- 跟踪令牌验证错误

## 参考资料

- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html)
- [RFC 7519 - JSON Web Token (JWT)](https://tools.ietf.org/html/rfc7519)
- [RFC 7515 - JSON Web Signature (JWS)](https://tools.ietf.org/html/rfc7515)
- [RFC 7517 - JSON Web Key (JWK)](https://tools.ietf.org/html/rfc7517)
