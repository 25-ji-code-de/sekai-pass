# State 参数实现

## 概述

SEKAI Pass OAuth 实现中使用 `state` 参数用于 CSRF 保护，这是 OAuth 2.1 规范所要求的。

## 什么是 State 参数？

State 参数是客户端用于在授权请求和回调之间维护状态的不透明值。它作为 CSRF 令牌，防止授权码注入攻击。

## 实现细节

### 授权流程

1. **授权请求** - 客户端包含 `state` 参数：
   ```
   GET /oauth/authorize?
     client_id=xxx&
     redirect_uri=https://app.example.com/callback&
     response_type=code&
     code_challenge=xxx&
     code_challenge_method=S256&
     state=random_csrf_token
   ```

2. **授权响应** - 服务器在重定向中返回 `state`：
   ```
   https://app.example.com/callback?
     code=authorization_code&
     state=random_csrf_token
   ```

3. **客户端验证** - 客户端必须验证返回的 `state` 与原始值匹配

### 错误响应

当用户拒绝授权时，`state` 也会被返回：
```
https://app.example.com/callback?
  error=access_denied&
  state=random_csrf_token
```

## 安全考虑

### 为什么 State 参数很重要

1. **CSRF 保护**：防止攻击者将授权码注入到合法客户端会话中
2. **会话绑定**：确保授权响应对应于原始请求
3. **OAuth 2.1 合规性**：OAuth 2.1 规范要求使用 state 参数以确保安全

### 最佳实践

1. **生成随机 State**：使用加密安全的随机值（最少 128 位熵）
2. **安全存储 State**：存储在会话存储或加密 cookie 中
3. **验证 State**：始终验证返回的 state 与原始值匹配
4. **单次使用**：State 应该只使用一次，然后丢弃
5. **时间限制**：State 应该在合理时间后过期（例如 10 分钟）

## 使用示例

### JavaScript 客户端

```javascript
// 生成 state
const state = crypto.randomUUID();
sessionStorage.setItem('oauth_state', state);

// 构建授权 URL
const authUrl = new URL('https://id.nightcord.de5.net/oauth/authorize');
authUrl.searchParams.set('client_id', 'your_client_id');
authUrl.searchParams.set('redirect_uri', 'https://your-app.com/callback');
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('code_challenge', codeChallenge);
authUrl.searchParams.set('code_challenge_method', 'S256');
authUrl.searchParams.set('state', state);

// 重定向到授权
window.location.href = authUrl.toString();
```

### 回调处理

```javascript
// 在回调处理器中
const params = new URLSearchParams(window.location.search);
const returnedState = params.get('state');
const storedState = sessionStorage.getItem('oauth_state');

// 验证 state
if (!returnedState || returnedState !== storedState) {
  throw new Error('Invalid state parameter - possible CSRF attack');
}

// 清除已使用的 state
sessionStorage.removeItem('oauth_state');

// 继续令牌交换
const code = params.get('code');
// ... 交换 code 获取 token
```

### Python 客户端

```python
import secrets
from flask import session, redirect, request

# 生成并存储 state
state = secrets.token_urlsafe(32)
session['oauth_state'] = state

# 构建授权 URL
auth_url = (
    f"https://id.nightcord.de5.net/oauth/authorize?"
    f"client_id={client_id}&"
    f"redirect_uri={redirect_uri}&"
    f"response_type=code&"
    f"code_challenge={code_challenge}&"
    f"code_challenge_method=S256&"
    f"state={state}"
)

return redirect(auth_url)

# 在回调处理器中
@app.route('/callback')
def callback():
    returned_state = request.args.get('state')
    stored_state = session.pop('oauth_state', None)

    if not returned_state or returned_state != stored_state:
        return 'Invalid state parameter', 400

    # 继续令牌交换
    code = request.args.get('code')
    # ...
```

## 测试

### 使用 State 参数测试

```bash
# 1. 使用 state 开始授权
curl -i "https://id.nightcord.de5.net/oauth/authorize?\
client_id=test_client&\
redirect_uri=https://example.com/callback&\
response_type=code&\
code_challenge=test_challenge&\
code_challenge_method=S256&\
state=test_state_12345"

# 2. 验证重定向包含 state
# 预期：https://example.com/callback?code=xxx&state=test_state_12345
```

### 测试带 State 的错误响应

```bash
# 当用户拒绝授权时
# 预期：https://example.com/callback?error=access_denied&state=test_state_12345
```

## 参考资料

- [RFC 6749 Section 4.1.1](https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.1) - 授权请求
- [RFC 6749 Section 10.12](https://datatracker.ietf.org/doc/html/rfc6749#section-10.12) - 跨站请求伪造
- [OAuth 2.1 Draft](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/) - State 参数要求

## 相关文件

- `schema.sql` - 包含 state 列的数据库架构
- `src/index.ts` - 授权端点实现
- `src/lib/api.ts` - API 授权端点
- `src/lib/html.ts` - HTML 表单模板
- `public/js/pages/authorize.js` - 前端授权处理器
