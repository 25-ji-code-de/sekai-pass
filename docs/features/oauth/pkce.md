# 强制 PKCE 实现

## 概述

PKCE（Proof Key for Code Exchange，代码交换证明密钥）对 SEKAI Pass 中的所有 OAuth 客户端都是**强制性的**，这是 OAuth 2.1 规范所要求的。这消除了授权码拦截攻击向量。

## 实现细节

### 1. 授权端点

**GET /oauth/authorize**

需要 `code_challenge` 参数：

```http
GET /oauth/authorize?
  client_id=xxx&
  redirect_uri=https://app.example.com/callback&
  response_type=code&
  code_challenge=BASE64URL(SHA256(code_verifier))&
  code_challenge_method=S256&
  state=random_state
```

**错误响应**（如果缺少 code_challenge）：
```
HTTP/1.1 400 Bad Request
code_challenge is required (PKCE mandatory)
```

### 2. 令牌端点

**POST /oauth/token**

需要 `code_verifier` 参数：

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&
code=authorization_code&
client_id=xxx&
code_verifier=original_random_string&
redirect_uri=https://app.example.com/callback
```

**错误响应：**

缺少 code_verifier：
```json
{
  "error": "invalid_request",
  "error_description": "code_verifier is required"
}
```

无效的 code_verifier 格式：
```json
{
  "error": "invalid_request",
  "error_description": "invalid code_verifier format"
}
```

Code verifier 与 challenge 不匹配：
```json
{
  "error": "invalid_grant",
  "error_description": "code_verifier does not match code_challenge"
}
```

### 3. Discovery 端点

**GET /.well-known/oauth-authorization-server**

反映强制 PKCE：

```json
{
  "issuer": "https://id.nightcord.de5.net",
  "authorization_endpoint": "https://id.nightcord.de5.net/oauth/authorize",
  "token_endpoint": "https://id.nightcord.de5.net/oauth/token",
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"]
}
```

## PKCE 流程

### 步骤 1：生成 Code Verifier

```javascript
// 生成随机 code verifier（43-128 个字符）
function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64URLEncode(array);
}

function base64URLEncode(buffer) {
  return btoa(String.fromCharCode(...buffer))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

const codeVerifier = generateCodeVerifier();
// 安全存储（sessionStorage、内存等）
sessionStorage.setItem('pkce_code_verifier', codeVerifier);
```

### 步骤 2：生成 Code Challenge

```javascript
async function generateCodeChallenge(codeVerifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64URLEncode(new Uint8Array(hash));
}

const codeChallenge = await generateCodeChallenge(codeVerifier);
```

### 步骤 3：授权请求

```javascript
const authUrl = new URL('https://id.nightcord.de5.net/oauth/authorize');
authUrl.searchParams.set('client_id', 'your_client_id');
authUrl.searchParams.set('redirect_uri', 'https://your-app.com/callback');
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('code_challenge', codeChallenge);
authUrl.searchParams.set('code_challenge_method', 'S256');
authUrl.searchParams.set('state', generateState());

window.location.href = authUrl.toString();
```

### 步骤 4：令牌交换

```javascript
// 在回调处理器中
const code = new URLSearchParams(window.location.search).get('code');
const codeVerifier = sessionStorage.getItem('pkce_code_verifier');

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
// 清理
sessionStorage.removeItem('pkce_code_verifier');
```

## 安全优势

### 1. 授权码拦截保护

**攻击场景（没有 PKCE）：**
1. 攻击者拦截重定向中的授权码
2. 攻击者交换授权码获取访问令牌
3. 攻击者获得未授权访问

**保护（使用 PKCE）：**
1. 攻击者拦截授权码
2. 攻击者无法交换授权码（缺少 code_verifier）
3. 攻击失败 ✅

### 2. 无需共享密钥

- 公共客户端（SPA、移动应用）不需要 client_secret
- 客户端代码中没有密钥暴露风险
- 即使在不受信任的设备上也安全

### 3. 动态的每请求安全性

- 每个授权请求都有唯一的 code_verifier
- Code verifier 永远不会通过网络传输
- 只发送 SHA-256 哈希（code_challenge）

## 测试

### 测试 PKCE 流程

```bash
# 1. 生成 code verifier
CODE_VERIFIER=$(openssl rand -base64 32 | tr -d '=' | tr '+/' '-_')
echo "Code Verifier: $CODE_VERIFIER"

# 2. 生成 code challenge
CODE_CHALLENGE=$(echo -n "$CODE_VERIFIER" | openssl dgst -sha256 -binary | base64 | tr -d '=' | tr '+/' '-_')
echo "Code Challenge: $CODE_CHALLENGE"

# 3. 测试授权（将重定向到登录）
curl -i "https://id.nightcord.de5.net/oauth/authorize?\
client_id=test_client&\
redirect_uri=https://example.com/callback&\
response_type=code&\
code_challenge=$CODE_CHALLENGE&\
code_challenge_method=S256&\
state=test_state"

# 4. 获取 code 后，测试令牌交换
curl -X POST https://id.nightcord.de5.net/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=AUTHORIZATION_CODE" \
  -d "client_id=test_client" \
  -d "code_verifier=$CODE_VERIFIER" \
  -d "redirect_uri=https://example.com/callback"
```

### 测试错误情况

```bash
# 测试缺少 code_challenge
curl -i "https://id.nightcord.de5.net/oauth/authorize?\
client_id=test_client&\
redirect_uri=https://example.com/callback&\
response_type=code"
# 预期：400 Bad Request - code_challenge is required

# 测试缺少 code_verifier
curl -X POST https://id.nightcord.de5.net/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=AUTHORIZATION_CODE" \
  -d "client_id=test_client"
# 预期：{"error":"invalid_request","error_description":"code_verifier is required"}

# 测试错误的 code_verifier
curl -X POST https://id.nightcord.de5.net/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=AUTHORIZATION_CODE" \
  -d "client_id=test_client" \
  -d "code_verifier=wrong_verifier"
# 预期：{"error":"invalid_grant","error_description":"code_verifier does not match code_challenge"}
```

## Code Challenge 方法

### S256（强制）
- 使用 SHA-256 哈希
- 更安全
- **根据 OAuth 2.1 必须实现**
- **SEKAI Pass 仅支持此方法**

```javascript
code_challenge = BASE64URL(SHA256(code_verifier))
```

**注意：** SEKAI Pass 已禁用 `plain` 方法以符合 OAuth 2.1 最佳实践。所有客户端必须使用 S256 方法。

## 库支持

### JavaScript/TypeScript

**oauth4webapi**（推荐）
```javascript
import * as oauth from 'oauth4webapi';

const codeVerifier = oauth.generateRandomCodeVerifier();
const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
```

**自定义实现**
```javascript
// 参见上面"PKCE 流程"部分的完整实现
```

### Python

**Authlib**
```python
from authlib.integrations.requests_client import OAuth2Session

client = OAuth2Session(
    client_id='your_client_id',
    redirect_uri='https://your-app.com/callback',
    code_challenge_method='S256'  # 启用 PKCE
)

authorization_url, state = client.create_authorization_url(
    'https://id.nightcord.de5.net/oauth/authorize'
)
```

### Go

**golang.org/x/oauth2**
```go
import (
    "golang.org/x/oauth2"
    "github.com/nirasan/go-oauth-pkce-code-verifier"
)

verifier, _ := cv.CreateCodeVerifier()
challenge := verifier.CodeChallengeS256()

authURL := config.AuthCodeURL(
    state,
    oauth2.SetAuthURLParam("code_challenge", challenge),
    oauth2.SetAuthURLParam("code_challenge_method", "S256"),
)
```

## 参考资料

- [RFC 7636 - Proof Key for Code Exchange (PKCE)](https://datatracker.ietf.org/doc/html/rfc7636)
- [OAuth 2.1 Draft](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/)
- [OAuth 2.0 Security Best Current Practice](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics)

## 相关文件

- `src/index.ts` - 授权和令牌端点
- `src/lib/api.ts` - API 授权端点
- `src/lib/pkce.ts` - PKCE 验证和校验
