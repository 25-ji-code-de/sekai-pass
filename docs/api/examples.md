# API 测试示例

## 使用 curl 测试 API

### 1. 注册新用户

```bash
curl -X POST https://id.nightcord.de5.net/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "testuser",
    "email": "test@example.com",
    "p": "base64_encoded_password",
    "display_name": "Test User",
    "nonce": "random_nonce",
    "fp": "browser_fingerprint",
    "ts": 1234567890,
    "cf-turnstile-response": "turnstile_token"
  }'
```

### 2. 登录

```bash
curl -X POST https://id.nightcord.de5.net/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "testuser",
    "p": "base64_encoded_password",
    "nonce": "random_nonce",
    "fp": "browser_fingerprint",
    "ts": 1234567890,
    "cf-turnstile-response": "turnstile_token"
  }'
```

响应示例：
```json
{
  "success": true,
  "token": "session_token_here",
  "user": {
    "id": "user_id",
    "username": "testuser",
    "email": "test@example.com",
    "display_name": "Test User"
  }
}
```

### 3. 获取用户信息

```bash
curl -X GET https://id.nightcord.de5.net/api/auth/me \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

响应示例：
```json
{
  "id": "user_id",
  "username": "testuser",
  "email": "test@example.com",
  "display_name": "Test User"
}
```

### 4. 获取 OAuth 应用信息

```bash
curl -X GET "https://id.nightcord.de5.net/api/oauth/app-info?client_id=YOUR_CLIENT_ID" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

### 5. OAuth 授权

```bash
curl -X POST https://id.nightcord.de5.net/api/oauth/authorize \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "your_client_id",
    "redirect_uri": "https://your-app.com/callback",
    "action": "allow"
  }'
```

响应示例：
```json
{
  "success": true,
  "code": "authorization_code_here"
}
```

### 6. 获取访问令牌（标准 OAuth）

```bash
curl -X POST https://id.nightcord.de5.net/oauth/token \
  -d "grant_type=authorization_code" \
  -d "code=authorization_code_here" \
  -d "client_id=your_client_id" \
  -d "client_secret=your_client_secret"
```

响应示例：
```json
{
  "access_token": "access_token_here",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

### 7. 获取用户信息（标准 OAuth）

```bash
curl -X GET https://id.nightcord.de5.net/oauth/userinfo \
  -H "Authorization: Bearer ACCESS_TOKEN_HERE"
```

## 使用 JavaScript Fetch API

### 登录示例

```javascript
import { encryptPassword, generateNonce, getFingerprint } from './utils.js';

async function login(username, password) {
  const encryptedPassword = await encryptPassword(password);
  const nonce = generateNonce();
  const fingerprint = getFingerprint();
  const timestamp = Date.now();

  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username,
      p: encryptedPassword,
      nonce,
      fp: fingerprint,
      ts: timestamp,
      'cf-turnstile-response': turnstileToken
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Login failed');
  }

  const data = await response.json();
  localStorage.setItem('token', data.token);
  return data;
}
```

### 获取用户信息示例

```javascript
async function getCurrentUser() {
  const token = localStorage.getItem('token');

  const response = await fetch('/api/auth/me', {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  if (response.status === 401) {
    // Token expired
    localStorage.removeItem('token');
    window.location.href = '/login';
    return;
  }

  if (!response.ok) {
    throw new Error('Failed to get user info');
  }

  return await response.json();
}
```

## 错误处理

所有 API 端点在出错时返回 JSON 格式的错误信息：

```json
{
  "error": "错误描述"
}
```

常见 HTTP 状态码：
- `200` - 成功
- `400` - 请求参数错误
- `401` - 未授权（Token 过期或无效）
- `403` - 禁止访问
- `404` - 资源不存在
- `500` - 服务器内部错误

## PKCE 流程示例

### 1. 生成 code_verifier 和 code_challenge

```javascript
// 生成随机 code_verifier
function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64URLEncode(array);
}

// 生成 code_challenge
async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64URLEncode(new Uint8Array(hash));
}

function base64URLEncode(buffer) {
  return btoa(String.fromCharCode(...buffer))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
```

### 2. 发起授权请求

```javascript
const codeVerifier = generateCodeVerifier();
const codeChallenge = await generateCodeChallenge(codeVerifier);

// 保存 code_verifier 用于后续交换 token
sessionStorage.setItem('code_verifier', codeVerifier);

// 重定向到授权页面
window.location.href = `/oauth/authorize?` +
  `client_id=YOUR_CLIENT_ID&` +
  `redirect_uri=YOUR_REDIRECT_URI&` +
  `response_type=code&` +
  `code_challenge=${codeChallenge}&` +
  `code_challenge_method=S256`;
```

### 3. 交换授权码获取 token

```javascript
const code = new URLSearchParams(window.location.search).get('code');
const codeVerifier = sessionStorage.getItem('code_verifier');

const response = await fetch('/oauth/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    client_id: 'YOUR_CLIENT_ID',
    code_verifier: codeVerifier
  })
});

const data = await response.json();
// data.access_token 即为访问令牌
```
