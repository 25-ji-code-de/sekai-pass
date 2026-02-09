# OIDC 快速开始指南

5 分钟快速开始使用 OpenID Connect 认证。

## 前置要求

- 已部署的 SEKAI Pass 实例
- 已配置回调 URI 的客户端应用

## 步骤 1: 注册应用

使用 OIDC 之前，需要先注册 OAuth 应用。

### 注册账户

如果还没有账户：

1. 访问 https://id.nightcord.de5.net
2. 点击"注册"
3. 填写信息（用户名、邮箱、密码、显示名称）
4. 完成验证码验证
5. 提交注册

### 创建 OAuth 应用

**方法：使用数据库（当前方法）**

由于应用管理 UI 正在开发中，需要直接在数据库中注册应用：

```bash
# 本地开发环境
npx wrangler d1 execute sekai_pass_db --local --command "
INSERT INTO applications (id, name, client_id, client_secret, redirect_uris, created_at)
VALUES (
  'app-' || hex(randomblob(8)),
  'My OIDC App',
  'client-' || hex(randomblob(12)),
  'secret-' || hex(randomblob(16)),
  '[\"http://localhost:3000/callback\",\"https://your-app.com/callback\"]',
  $(date +%s)000
)
RETURNING client_id, client_secret;"

# 生产环境（使用 --remote 替换 --local）
npx wrangler d1 execute sekai_pass_db --remote --command "..."
```

**重要**: 保存输出的 `client_id` 和 `client_secret` - 认证时需要使用。

## 步骤 2: 授权请求

将用户重定向到授权端点，包含 `openid` scope：

```
https://id.nightcord.de5.net/oauth/authorize?
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://your-app.com/callback&
  response_type=code&
  scope=openid%20profile%20email&
  code_challenge=CHALLENGE&
  code_challenge_method=S256&
  state=RANDOM_STATE&
  nonce=RANDOM_NONCE
```

**必需参数：**
- `client_id`: 应用的 client ID
- `redirect_uri`: 回调 URL（必须预先注册）
- `response_type`: 必须是 `code`
- `scope`: 必须包含 `openid`（可添加 `profile` 和/或 `email` 获取额外声明）
- `code_challenge`: PKCE 挑战码（verifier 的 SHA256 哈希的 base64url 编码）
- `code_challenge_method`: `S256`（推荐）或 `plain`
- `state`: 用于 CSRF 防护的随机字符串
- `nonce`: 用于重放防护的随机字符串（推荐）

## 步骤 3: 处理回调

用户批准后会重定向回来，带上授权码：

```
https://your-app.com/callback?
  code=AUTH_CODE&
  state=RANDOM_STATE
```

验证 `state` 是否匹配原始值。

## 步骤 4: 交换令牌

POST 到令牌端点：

```bash
curl -X POST https://id.nightcord.de5.net/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=AUTH_CODE" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "code_verifier=VERIFIER"
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

## 步骤 5: 验证 ID Token

### 选项 A: 使用库（推荐）

**Node.js:**

```javascript
const { Issuer } = require('openid-client');

const issuer = await Issuer.discover('https://id.nightcord.de5.net');
const client = new issuer.Client({
  client_id: 'YOUR_CLIENT_ID',
});

const tokenSet = await client.callback(
  'https://your-app.com/callback',
  { code: 'AUTH_CODE' },
  { code_verifier: 'VERIFIER', nonce: 'NONCE' }
);

// ID token 自动验证
console.log(tokenSet.claims());
```

**Python:**

```python
from authlib.integrations.requests_client import OAuth2Session

client = OAuth2Session(
    client_id='YOUR_CLIENT_ID',
    code_verifier='VERIFIER',
)

token = client.fetch_token(
    'https://id.nightcord.de5.net/oauth/token',
    authorization_response='https://your-app.com/callback?code=AUTH_CODE',
)

# 验证 ID token
from authlib.jose import jwt
claims = jwt.decode(
    token['id_token'],
    jwks_uri='https://id.nightcord.de5.net/.well-known/jwks.json'
)
print(claims)
```

### 选项 B: 手动验证

1. **解码 JWT**（不验证）：

```javascript
const [headerB64, payloadB64, signatureB64] = idToken.split('.');
const header = JSON.parse(atob(headerB64));
const payload = JSON.parse(atob(payloadB64));
```

2. **获取公钥**：

```bash
curl https://id.nightcord.de5.net/.well-known/jwks.json
```

3. **验证签名** 使用与 header 中 `kid` 匹配的公钥

4. **验证声明**：
   - `iss` === `"https://id.nightcord.de5.net"`
   - `aud` === `YOUR_CLIENT_ID`
   - `exp` > 当前时间
   - `nonce` === 你的原始 nonce

## 步骤 6: 使用用户信息

从 ID token 声明中提取用户信息：

```javascript
const claims = tokenSet.claims();

console.log(claims.sub);                  // 用户 ID
console.log(claims.name);                 // 显示名称
console.log(claims.preferred_username);   // 用户名
console.log(claims.email);                // 邮箱地址
console.log(claims.email_verified);       // 邮箱验证状态
```

## 完整示例（Node.js）

```javascript
const express = require('express');
const { Issuer, generators } = require('openid-client');

const app = express();

let issuer, client;

// 初始化 OIDC 客户端
(async () => {
  issuer = await Issuer.discover('https://id.nightcord.de5.net');
  client = new issuer.Client({
    client_id: 'YOUR_CLIENT_ID',
    redirect_uris: ['http://localhost:3000/callback'],
    response_types: ['code'],
  });
})();

// 登录路由
app.get('/login', (req, res) => {
  const code_verifier = generators.codeVerifier();
  const code_challenge = generators.codeChallenge(code_verifier);
  const nonce = generators.nonce();
  const state = generators.state();

  // 存储在 session
  req.session.code_verifier = code_verifier;
  req.session.nonce = nonce;
  req.session.state = state;

  const authUrl = client.authorizationUrl({
    scope: 'openid profile email',
    code_challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });

  res.redirect(authUrl);
});

// 回调路由
app.get('/callback', async (req, res) => {
  const params = client.callbackParams(req);

  try {
    const tokenSet = await client.callback(
      'http://localhost:3000/callback',
      params,
      {
        code_verifier: req.session.code_verifier,
        state: req.session.state,
        nonce: req.session.nonce,
      }
    );

    // 在 session 中存储令牌
    req.session.tokens = tokenSet;

    // 获取用户信息
    const userinfo = tokenSet.claims();
    console.log('用户已登录:', userinfo);

    res.redirect('/dashboard');
  } catch (err) {
    console.error('认证错误:', err);
    res.status(500).send('认证失败');
  }
});

// 受保护路由
app.get('/dashboard', (req, res) => {
  if (!req.session.tokens) {
    return res.redirect('/login');
  }

  const claims = req.session.tokens.claims();
  res.send(`
    <h1>欢迎, ${claims.name}!</h1>
    <p>用户名: ${claims.preferred_username}</p>
    <p>邮箱: ${claims.email}</p>
    <p>用户 ID: ${claims.sub}</p>
  `);
});

app.listen(3000, () => {
  console.log('应用运行在 http://localhost:3000');
});
```

## 使用 curl 测试

### 1. 获取授权码（手动浏览器步骤）

在浏览器中访问：
```
https://id.nightcord.de5.net/oauth/authorize?client_id=test&redirect_uri=http://localhost:3000/callback&response_type=code&scope=openid%20profile%20email&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=abc123&nonce=xyz789
```

### 2. 交换令牌

```bash
curl -X POST https://id.nightcord.de5.net/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=YOUR_AUTH_CODE" \
  -d "client_id=test" \
  -d "code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
```

### 3. 解码 ID token

访问 https://jwt.io 并粘贴 `id_token` 来检查声明。

### 4. 验证签名

```bash
# 获取公钥
curl https://id.nightcord.de5.net/.well-known/jwks.json

# 使用 jwt.io 或 JWT 库验证签名
```

## 常见问题

### 响应中缺少 id_token

**原因**: 授权请求中未包含 `openid` scope

**解决**: 在 scope 参数中添加 `openid`：
```
scope=openid profile email
```

### 签名验证错误

**原因**: 使用了错误的公钥或时钟偏差

**解决**:
1. 从 JWKS 端点获取最新密钥
2. 检查系统时间是否同步
3. 允许 60 秒的时钟偏差

### Nonce 不匹配

**原因**: ID token 中的 nonce 与请求不匹配

**解决**: 确保向令牌验证传递相同的 nonce 值

### 重定向 URI 不匹配

**原因**: 重定向 URI 未注册或不完全匹配

**解决**: 确保重定向 URI 已在应用中注册。检查数据库：

```bash
# 查看应用配置
npx wrangler d1 execute sekai_pass_db --local --command "
SELECT id, name, client_id, redirect_uris
FROM applications
WHERE client_id = 'YOUR_CLIENT_ID';"

# 如需更新
npx wrangler d1 execute sekai_pass_db --local --command "
UPDATE applications
SET redirect_uris = '[\"http://localhost:3000/callback\",\"https://your-app.com/callback\"]'
WHERE client_id = 'YOUR_CLIENT_ID';"
```

## 快速测试（无需注册）

无需认证即可测试 OIDC Discovery 和 JWKS 端点：

```bash
# 测试 OIDC Discovery
curl https://id.nightcord.de5.net/.well-known/openid-configuration | jq

# 测试 JWKS
curl https://id.nightcord.de5.net/.well-known/jwks.json | jq

# 测试 OAuth Discovery（向后兼容）
curl https://id.nightcord.de5.net/.well-known/oauth-authorization-server | jq
```

## 生产环境注意事项

1. **使用 HTTPS**: 生产环境必须使用 HTTPS
2. **配置正确的重定向 URI**: 必须完全匹配
3. **保护 Client ID**: 不要在公共仓库中暴露
4. **使用环境变量**: 不要硬编码配置

```javascript
// 推荐的配置方式
const CONFIG = {
  issuer: process.env.OIDC_ISSUER || 'https://id.nightcord.de5.net',
  clientId: process.env.OIDC_CLIENT_ID,
  redirectUri: process.env.OIDC_REDIRECT_URI,
  scope: 'openid profile email'
};
```

## 下一步

- 阅读 [implementation.md](implementation.md) 了解详细文档
- 阅读 [troubleshooting.md](troubleshooting.md) 了解常见问题
- 探索 [OpenID Connect 规范](https://openid.net/specs/openid-connect-core-1_0.html)
- 查看 [示例代码](../../../examples/README.md) 了解集成示例

## 支持

如有问题：
- 查看 [troubleshooting.md](troubleshooting.md)
- 检查浏览器控制台错误
- 查看 Network 标签的请求详情
- 参考 [implementation.md](implementation.md) 了解技术细节
