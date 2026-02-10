# SEKAI Pass - OpenID Connect 示例

本目录包含 SEKAI Pass OpenID Connect (OIDC) 集成的各种示例代码。

## 📋 示例列表

### 1. 🌐 纯前端 OIDC 演示 (oidc-demo.html)

**特点:**
- 纯 HTML + JavaScript
- 完整的 OIDC 授权码流程
- PKCE 支持（S256）
- Nonce 防重放攻击
- ID Token 解码和显示
- Discovery 和 JWKS 测试

**使用方法:**
```bash
# 直接在浏览器中打开
open oidc-demo.html

# 或使用简单的 HTTP 服务器
python3 -m http.server 8080
# 然后访问 http://localhost:8080/oidc-demo.html
```

**配置:**
在 HTML 文件中修改配置：
```javascript
const CONFIG = {
  issuer: 'https://id.nightcord.de5.net',
  clientId: 'demo-client',  // 修改为你的 Client ID
  redirectUri: window.location.href.split('?')[0],
  scope: 'openid profile email'
};
```

### 2. 🚀 Node.js OIDC 客户端 (oidc-client-nodejs.js)

**特点:**
- 使用 `openid-client` 标准库
- Express.js 后端
- 自动 OIDC Discovery
- Session 管理
- ID Token 验证
- 用户信息展示

**安装依赖:**
```bash
cd examples
npm install
```

**运行:**
```bash
npm start

# 或使用 nodemon 自动重启
npm run dev
```

**访问:**
打开浏览器访问 http://localhost:3000

**配置:**
在 `oidc-client-nodejs.js` 中修改配置：
```javascript
const CONFIG = {
  issuer: 'https://id.nightcord.de5.net',
  clientId: 'demo-client',  // 修改为你的 Client ID
  redirectUri: 'http://localhost:3000/callback',
  scope: 'openid profile email'
};
```

### 3. 🐍 Python OIDC 客户端 (oidc-client-python.py)

**特点:**
- 使用 `Authlib` 标准库
- Flask 后端
- 自动 OIDC Discovery
- PKCE S256 保护
- 模板渲染

**安装依赖:**
```bash
cd examples
pip install -r requirements.txt
```

**运行:**
```bash
python oidc-client-python.py
```

**访问:**
打开浏览器访问 http://localhost:5000

**配置:**
在 `oidc-client-python.py` 中修改配置：
```python
CONFIG = {
    'issuer': 'https://id.nightcord.de5.net',
    'client_id': 'demo-client',  # 修改为你的 Client ID
    'redirect_uri': 'http://localhost:5000/callback',
    'scope': 'openid profile email'
}
```

### 4. 📱 传统 PKCE 前端示例 (pkce-frontend.html)

**特点:**
- OAuth 2.1 + PKCE
- 不包含 OIDC（无 ID Token）
- 适合纯 OAuth 场景

**使用方法:**
```bash
open pkce-frontend.html
```

## 🔧 配置要求

### 在 SEKAI Pass 中注册应用

在使用示例之前，需要在 SEKAI Pass 中注册 OAuth 应用。

**注意**: 应用管理 UI 尚未实现，需要通过数据库注册应用。

#### 使用 Wrangler CLI 注册应用

```bash
# 本地开发环境
npx wrangler d1 execute sekai_pass_db --local --command "
INSERT INTO applications (id, name, client_id, client_secret, redirect_uris, created_at)
VALUES (
  'app-' || hex(randomblob(8)),
  'Demo Application',
  'demo-client-' || hex(randomblob(8)),
  'secret-' || hex(randomblob(16)),
  '[\"http://localhost:3000/callback\",\"http://localhost:8080/oidc-demo.html\",\"http://localhost:5000/callback\"]',
  $(date +%s)000
)
RETURNING client_id, client_secret;"

# 生产环境（使用 --remote 替换 --local）
npx wrangler d1 execute sekai_pass_db --remote --command "..."
```

**记录凭据**: 保存输出的 `client_id` 和 `client_secret`，在示例配置中使用。

### 修改示例配置

在每个示例文件中，找到配置部分并修改：

```javascript
const CONFIG = {
  issuer: 'https://id.nightcord.de5.net',  // OIDC 授权服务器
  clientId: 'YOUR_CLIENT_ID',              // 替换为你的 Client ID
  redirectUri: 'YOUR_REDIRECT_URI',        // 替换为你的回调 URI
  scope: 'openid profile email'            // 请求的权限范围
};
```

## 📚 OIDC 流程说明

### 1. 授权请求

客户端重定向用户到授权端点：

```
GET /oauth/authorize?
  client_id=YOUR_CLIENT_ID&
  redirect_uri=YOUR_REDIRECT_URI&
  response_type=code&
  scope=openid%20profile%20email&
  code_challenge=CHALLENGE&
  code_challenge_method=S256&
  state=RANDOM_STATE&
  nonce=RANDOM_NONCE
```

**重要参数:**
- `scope`: 必须包含 `openid` 才能获取 ID Token
- `code_challenge`: PKCE 挑战码（SHA256 哈希）
- `nonce`: 防重放攻击的随机值

### 2. 用户授权

用户在 SEKAI Pass 登录并授权应用访问其信息。

### 3. 授权回调

SEKAI Pass 重定向回应用，带上授权码：

```
GET /callback?
  code=AUTHORIZATION_CODE&
  state=RANDOM_STATE
```

### 4. Token 交换

应用使用授权码交换 tokens：

```bash
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&
code=AUTHORIZATION_CODE&
client_id=YOUR_CLIENT_ID&
code_verifier=VERIFIER
```

**响应:**
```json
{
  "access_token": "...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "...",
  "scope": "openid profile email",
  "id_token": "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### 5. 验证 ID Token

ID Token 是一个 JWT，包含用户信息：

```json
{
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
  "email_verified": true
}
```

## 🔐 安全最佳实践

### 1. 使用 PKCE

所有示例都使用 PKCE (Proof Key for Code Exchange)：

```javascript
// 生成 code_verifier
const verifier = generateRandomString(32);

// 生成 code_challenge (SHA256)
const challenge = base64URLEncode(sha256(verifier));

// 授权请求时发送 challenge
// Token 交换时发送 verifier
```

### 2. 验证 State

防止 CSRF 攻击：

```javascript
// 授权前保存 state
sessionStorage.setItem('oauth_state', state);

// 回调时验证
if (params.state !== sessionStorage.getItem('oauth_state')) {
  throw new Error('State mismatch');
}
```

### 3. 验证 Nonce

防止重放攻击：

```javascript
// 授权前保存 nonce
sessionStorage.setItem('oidc_nonce', nonce);

// 验证 ID Token 中的 nonce
const claims = decodeJWT(idToken);
if (claims.nonce !== sessionStorage.getItem('oidc_nonce')) {
  throw new Error('Nonce mismatch');
}
```

### 4. 验证 ID Token 签名

使用 JWKS 端点获取公钥验证签名：

```javascript
// 获取 JWKS
const jwks = await fetch('https://id.nightcord.de5.net/.well-known/jwks.json');

// 使用公钥验证 JWT 签名
// (使用 jose 或 jsonwebtoken 库)
```

## 🧪 测试端点

### Discovery 端点

```bash
curl https://id.nightcord.de5.net/.well-known/openid-configuration | jq
```

### JWKS 端点

```bash
curl https://id.nightcord.de5.net/.well-known/jwks.json | jq
```

### UserInfo 端点

```bash
curl -H "Authorization: Bearer ACCESS_TOKEN" \
  https://id.nightcord.de5.net/oauth/userinfo | jq
```

## 📖 相关文档

- [OIDC 快速开始](../docs/features/oidc/quickstart.md) - 5分钟快速开始
- [OIDC 实现细节](../docs/features/oidc/implementation.md) - 完整技术文档
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) - 官方规范

## 🐛 常见问题

### 1. 没有收到 ID Token

**原因:** 授权请求中没有包含 `openid` scope

**解决:** 确保 scope 参数包含 `openid`:
```javascript
scope: 'openid profile email'
```

### 2. ID Token 签名验证失败

**原因:** 使用了错误的公钥或密钥已轮换

**解决:** 从 JWKS 端点获取最新的公钥

### 3. Nonce 不匹配

**原因:** 多个标签页或会话冲突

**解决:** 使用 sessionStorage 而不是 localStorage

### 4. CORS 错误

**原因:** 前端直接调用 token 端点

**解决:**
- 使用后端代理（推荐）
- 或在 SEKAI Pass 中配置 CORS（如果支持）

## 💡 提示

1. **开发环境:** 使用 `http://localhost` 进行测试
2. **生产环境:** 必须使用 HTTPS
3. **Client ID:** 每个应用需要唯一的 Client ID
4. **Redirect URI:** 必须完全匹配注册的 URI
5. **Scope:** `openid` 是必需的，其他 scope 可选

## 🤝 贡献

欢迎提交更多示例！支持的语言/框架：
- Python (Flask/Django)
- Java (Spring Boot)
- Go
- PHP
- Ruby (Rails)
- 等等...

## 📞 支持

如有问题，请查看：
- [OIDC 实现细节](../docs/features/oidc/implementation.md)
- [OIDC 故障排查](../docs/features/oidc/troubleshooting.md)
- [GitHub Issues](https://github.com/your-repo/issues)
