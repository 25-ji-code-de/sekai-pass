# 私钥 JWT 客户端认证（RFC 7523）

## 概述

SEKAI Pass 支持机密 OAuth 客户端的**私钥 JWT** 认证方式，符合 [RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523) 规范。这种认证方法允许服务端应用使用非对称加密进行身份验证，而不是使用共享密钥。

### 为什么使用私钥 JWT？

- **增强安全性**：无需存储或传输共享密钥
- **密钥轮换**：支持每个客户端使用多个密钥
- **OAuth 2.1 合规**：机密客户端推荐的认证方法
- **企业级就绪**：适用于服务器到服务器的认证

### 支持的算法

- **ES256**（ECDSA with P-256 and SHA-256）- 推荐
- **RS256**（RSA with SHA-256）

---

## 客户端类型

SEKAI Pass 支持两种类型的 OAuth 客户端：

### 公开客户端（Public Clients）
- **认证方法**：`none`
- **PKCE**：必需（仅支持 S256）
- **使用场景**：单页应用、移动应用、桌面应用
- **示例**：React 应用、iOS 应用

### 机密客户端（Confidential Clients）
- **认证方法**：`private_key_jwt`
- **PKCE**：可选（但推荐使用）
- **使用场景**：服务端应用
- **示例**：PHP 后端、Rails API、Django 应用

---

## JWT 断言要求

使用私钥 JWT 认证时，客户端必须创建包含以下声明的 JWT 断言：

### 必需声明

| 声明 | 说明 | 示例 |
|------|------|------|
| `iss` | 签发者 - 必须等于 `client_id` | `"my-app-client-id"` |
| `sub` | 主体 - 必须等于 `client_id` | `"my-app-client-id"` |
| `aud` | 受众 - 必须是令牌端点 URL | `"https://auth.example.com/oauth/token"` |
| `exp` | 过期时间（Unix 时间戳） | `1704067200` |
| `jti` | JWT ID - 用于防止重放攻击的唯一标识符 | `"550e8400-e29b-41d4-a716-446655440000"` |

### 可选声明

| 声明 | 说明 | 示例 |
|------|------|------|
| `iat` | 签发时间（Unix 时间戳） | `1704063600` |
| `nbf` | 生效时间（Unix 时间戳） | `1704063600` |

### JWT 头部

| 字段 | 说明 | 示例 |
|------|------|------|
| `alg` | 算法 - `ES256` 或 `RS256` | `"ES256"` |
| `typ` | 类型 - 必须是 `JWT` | `"JWT"` |
| `kid` | 密钥 ID - 标识使用哪个公钥 | `"key-2024-01"` |

### 验证规则

- **过期验证**：JWT 不能过期（`exp` > 当前时间）
- **最大生命周期**：JWT 过期时间必须在签发后 1 小时内
- **时钟偏移**：`iat` 验证允许 60 秒的时钟偏移容差
- **重放防护**：每个 `jti` 只能使用一次
- **签名验证**：必须使用客户端注册的公钥验证签名

---

## 密钥管理

### 注册公钥

1. 生成密钥对（ES256 或 RS256）
2. 将公钥存储到 `client_keys` 表：

```sql
INSERT INTO client_keys (
    id,
    client_id,
    key_id,
    public_key_jwk,
    algorithm,
    created_at,
    status
) VALUES (
    'key-uuid',
    'my-client-id',
    'key-2024-01',
    '{"kty":"EC","crv":"P-256","x":"...","y":"..."}',
    'ES256',
    1704063600000,
    'active'
);
```

3. 更新应用的认证方法：

```sql
UPDATE applications
SET token_endpoint_auth_method = 'private_key_jwt'
WHERE client_id = 'my-client-id';
```

### 密钥轮换

实现零停机密钥轮换：

1. 添加新的公钥（使用不同的 `key_id`）
2. 更新客户端使用新私钥签名
3. 过渡期后撤销旧密钥：

```sql
UPDATE client_keys
SET status = 'revoked'
WHERE client_id = 'my-client-id' AND key_id = 'old-key-id';
```

### 多密钥支持

客户端可以同时拥有多个活跃密钥，用于：
- 零停机密钥轮换
- 不同环境（测试、生产）
- 同一客户端的不同服务

---

## 示例代码

### Node.js（ES256）

```javascript
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// 生成 ES256 密钥对（一次性设置）
function generateES256KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'jwk' },
    privateKeyEncoding: { type: 'pkcs8', format: 'jwk' }
  });

  return { publicKey, privateKey };
}

// 创建 JWT 断言
function createJWTAssertion(clientId, tokenEndpoint, privateKeyJWK, kid) {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: 'ES256',
    typ: 'JWT',
    kid: kid
  };

  const payload = {
    iss: clientId,
    sub: clientId,
    aud: tokenEndpoint,
    exp: now + 300, // 5 分钟
    iat: now,
    jti: uuidv4()
  };

  // 编码头部和载荷
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  // 使用私钥签名
  const privateKey = crypto.createPrivateKey({
    key: privateKeyJWK,
    format: 'jwk'
  });

  const signature = crypto.sign(
    null,
    Buffer.from(signingInput),
    {
      key: privateKey,
      dsaEncoding: 'ieee-p1363'
    }
  );

  return `${signingInput}.${base64url(signature)}`;
}

// Base64URL 编码
function base64url(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// 用授权码交换令牌
async function exchangeCodeForTokens(code, clientId, tokenEndpoint, privateKeyJWK, kid, redirectUri) {
  const assertion = createJWTAssertion(clientId, tokenEndpoint, privateKeyJWK, kid);

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      client_id: clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
      redirect_uri: redirectUri
    })
  });

  return await response.json();
}

// 使用示例
const { publicKey, privateKey } = generateES256KeyPair();
console.log('公钥（注册此密钥）:', JSON.stringify(publicKey));
console.log('私钥（保密）:', JSON.stringify(privateKey));

// 稍后，交换授权码时
const tokens = await exchangeCodeForTokens(
  'auth_code_here',
  'my-client-id',
  'https://auth.example.com/oauth/token',
  privateKey,
  'key-2024-01',
  'https://myapp.com/callback'
);
```

### Python（ES256）

```python
import json
import time
import uuid
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend
import jwt
import requests

# 生成 ES256 密钥对（一次性设置）
def generate_es256_keypair():
    private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
    public_key = private_key.public_key()

    return private_key, public_key

# 创建 JWT 断言
def create_jwt_assertion(client_id, token_endpoint, private_key, kid):
    now = int(time.time())

    payload = {
        'iss': client_id,
        'sub': client_id,
        'aud': token_endpoint,
        'exp': now + 300,  # 5 分钟
        'iat': now,
        'jti': str(uuid.uuid4())
    }

    headers = {
        'kid': kid
    }

    # 签名 JWT
    token = jwt.encode(
        payload,
        private_key,
        algorithm='ES256',
        headers=headers
    )

    return token

# 用授权码交换令牌
def exchange_code_for_tokens(code, client_id, token_endpoint, private_key, kid, redirect_uri):
    assertion = create_jwt_assertion(client_id, token_endpoint, private_key, kid)

    response = requests.post(token_endpoint, data={
        'grant_type': 'authorization_code',
        'code': code,
        'client_id': client_id,
        'client_assertion_type': 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        'client_assertion': assertion,
        'redirect_uri': redirect_uri
    })

    return response.json()

# 使用示例
private_key, public_key = generate_es256_keypair()
print('向 SEKAI Pass 注册公钥')

# 稍后，交换授权码时
tokens = exchange_code_for_tokens(
    'auth_code_here',
    'my-client-id',
    'https://auth.example.com/oauth/token',
    private_key,
    'key-2024-01',
    'https://myapp.com/callback'
)
```

---

## 令牌请求

### 请求格式

```http
POST /oauth/token HTTP/1.1
Host: auth.example.com
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=AUTH_CODE
&client_id=my-client-id
&client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
&client_assertion=eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImtleS0yMDI0LTAxIn0...
&redirect_uri=https://myapp.com/callback
```

### 参数说明

| 参数 | 必需 | 说明 |
|------|------|------|
| `grant_type` | 是 | `authorization_code` 或 `refresh_token` |
| `code` | 是（授权码流程） | 授权码 |
| `client_id` | 是 | 客户端标识符 |
| `client_assertion_type` | 是 | 必须是 `urn:ietf:params:oauth:client-assertion-type:jwt-bearer` |
| `client_assertion` | 是 | 使用客户端私钥签名的 JWT 断言 |
| `redirect_uri` | 是（授权码流程） | 必须与授权请求匹配 |
| `code_verifier` | 可选 | PKCE 代码验证器（即使对机密客户端也推荐使用） |

### 成功响应

```json
{
  "access_token": "eyJhbGc...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "def502...",
  "scope": "profile email"
}
```

---

## 测试

### 使用 curl 和 openssl

1. **生成 ES256 密钥对**：

```bash
# 生成私钥
openssl ecparam -name prime256v1 -genkey -noout -out private-key.pem

# 提取公钥
openssl ec -in private-key.pem -pubout -out public-key.pem

# 转换为 JWK（使用在线工具或 jose 库）
```

2. **创建 JWT 断言**（使用 jwt.io 或 jose-cli）：

```bash
# 安装 jose-cli
npm install -g jose-cli

# 创建 JWT
jose sign --key private-key.pem \
  --alg ES256 \
  --kid key-2024-01 \
  --iss my-client-id \
  --sub my-client-id \
  --aud https://auth.example.com/oauth/token \
  --exp +5m \
  --jti $(uuidgen)
```

3. **发起令牌请求**：

```bash
curl -X POST https://auth.example.com/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=AUTH_CODE" \
  -d "client_id=my-client-id" \
  -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  -d "client_assertion=eyJhbGc..." \
  -d "redirect_uri=https://myapp.com/callback"
```

---

## 错误响应

### JWT 格式无效

```json
{
  "error": "invalid_client",
  "error_description": "Invalid JWT format"
}
```

### 缺少必需声明

```json
{
  "error": "invalid_client",
  "error_description": "Missing required claim: jti"
}
```

### 签名无效

```json
{
  "error": "invalid_client",
  "error_description": "Invalid JWT signature"
}
```

### JWT 已过期

```json
{
  "error": "invalid_client",
  "error_description": "JWT has expired"
}
```

### 检测到重放攻击

```json
{
  "error": "invalid_client",
  "error_description": "JWT has already been used (replay detected)"
}
```

### 受众无效

```json
{
  "error": "invalid_client",
  "error_description": "Invalid audience. Expected: https://auth.example.com/oauth/token"
}
```

### 未找到公钥

```json
{
  "error": "invalid_client",
  "error_description": "Public key not found for client_id=my-client-id, kid=key-2024-01"
}
```

---

## 故障排除

### 常见问题

#### 1. "Invalid JWT signature"（签名无效）

**原因**：
- 使用了错误的私钥签名
- 密钥 ID（`kid`）与注册的公钥不匹配
- 算法不匹配（ES256 vs RS256）

**解决方案**：
- 验证 JWT 头部中的 `kid` 与注册的密钥匹配
- 确保使用正确的私钥
- 检查算法是否与注册的密钥匹配

#### 2. "JWT has expired"（JWT 已过期）

**原因**：
- 客户端和服务器之间的时钟偏移
- JWT 生命周期过长

**解决方案**：
- 同步系统时钟（使用 NTP）
- 将 `exp` 设置为当前时间 + 5 分钟（不要更长）

#### 3. "JWT has already been used"（JWT 已被使用）

**原因**：
- 重复使用相同的 JWT 断言
- 未为每个请求生成唯一的 `jti`

**解决方案**：
- 为每个令牌请求生成新的 JWT
- 使用 UUID 或随机字符串作为 `jti`

#### 4. "Invalid audience"（受众无效）

**原因**：
- `aud` 声明中的令牌端点 URL 错误
- 缺少 `/oauth/token` 路径

**解决方案**：
- 使用完整的令牌端点 URL：`https://auth.example.com/oauth/token`
- 包含协议（https://）和路径

#### 5. "Public key not found"（未找到公钥）

**原因**：
- 密钥未在数据库中注册
- JWT 头部中的 `kid` 错误
- 密钥状态为 'revoked'

**解决方案**：
- 验证密钥已使用正确的 `kid` 注册
- 检查密钥状态为 'active'
- 确保 `client_id` 匹配

---

## 安全考虑

### 最佳实践

1. **密钥存储**：安全存储私钥（HSM、密钥保管库、加密存储）
2. **密钥轮换**：定期轮换密钥（每 90-180 天）
3. **短 JWT 生命周期**：JWT 断言使用 5 分钟过期时间
4. **唯一 JTI**：为每个请求生成加密安全的随机 `jti`
5. **仅 HTTPS**：令牌端点始终使用 HTTPS（localhost 除外）
6. **审计日志**：记录所有认证尝试和失败

### 攻击防护

- **重放攻击**：通过 `jti` 跟踪防止
- **令牌盗窃**：通过签名验证缓解
- **算法混淆**：仅允许 ES256 和 RS256
- **过期 JWT**：严格的过期时间强制执行
- **时钟偏移**：`iat` 允许 60 秒容差

---

## 迁移指南

### 从公开客户端升级到机密客户端

1. **生成密钥对**（推荐 ES256）
2. **在 `client_keys` 表中注册公钥**
3. **更新认证方法**：
   ```sql
   UPDATE applications
   SET token_endpoint_auth_method = 'private_key_jwt'
   WHERE client_id = 'your-client-id';
   ```
4. **更新客户端代码**以创建 JWT 断言
5. **先在测试环境测试**
6. **部署到生产环境**

### 向后兼容性

- 现有公开客户端继续正常工作
- 使用 PKCE 的客户端无需更改
- 可以在不影响现有客户端的情况下添加新的机密客户端

---

## 参考资料

- [RFC 7523 - JSON Web Token (JWT) Profile for OAuth 2.0 Client Authentication](https://datatracker.ietf.org/doc/html/rfc7523)
- [RFC 7519 - JSON Web Token (JWT)](https://datatracker.ietf.org/doc/html/rfc7519)
- [RFC 7515 - JSON Web Signature (JWS)](https://datatracker.ietf.org/doc/html/rfc7515)
- [OAuth 2.1 草案](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-11)
