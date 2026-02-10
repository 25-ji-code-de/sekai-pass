# OIDC 故障排查指南

## 常见问题

### 问题 1: 没有 KEY_ENCRYPTION_SECRET

**错误信息:**
```
Error: KEY_ENCRYPTION_SECRET is not defined
```

**解决方案:**
```bash
# 生成随机密钥
openssl rand -hex 32

# 设置 secret
wrangler secret put KEY_ENCRYPTION_SECRET
# 粘贴上面生成的密钥
```

### 问题 2: KV namespace 未配置

**错误信息:**
```
Error: KV namespace binding not found
```

**解决方案:**

1. 创建 KV namespace:
```bash
wrangler kv:namespace create "OIDC_KEYS"
wrangler kv:namespace create "OIDC_KEYS" --preview
```

2. 更新 `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "KV"
id = "YOUR_NAMESPACE_ID"  # 替换为实际 ID
preview_id = "YOUR_PREVIEW_ID"  # 替换为实际 ID
```

3. 重新部署:
```bash
npm run deploy
```

### 问题 3: JWKS 端点返回空

**现象:**
```json
{
  "keys": []
}
```

**原因:** 签名密钥还未生成（首次 OIDC 请求时自动生成）

**解决方案:** 这是正常的，完成一次 OIDC 授权流程后会自动生成密钥。

### 问题 4: ID Token 验证失败

**错误信息:**
```
Invalid signature
```

**可能原因:**
1. 使用了错误的公钥
2. 密钥已轮换
3. 时钟不同步

**解决方案:**
```bash
# 1. 获取最新的 JWKS
curl https://id.nightcord.de5.net/.well-known/jwks.json

# 2. 检查 ID Token 的 kid 是否匹配
# 在 jwt.io 解码 ID Token，查看 header 中的 kid

# 3. 确保系统时间同步
date
```

### 问题 5: Redirect URI 不匹配

**错误信息:**
```
Invalid redirect URI
```

**解决方案:**

确保应用注册时的 redirect_uris 包含当前使用的 URI：

```bash
# 查看应用配置
curl -X GET https://id.nightcord.de5.net/api/applications \
  -b cookies.txt

# 更新应用（如果需要）
curl -X PUT https://id.nightcord.de5.net/api/applications/{app_id} \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "redirect_uris": [
      "http://localhost:8080/oidc-demo.html",
      "http://localhost:3000/callback",
      "http://localhost:5000/callback"
    ]
  }'
```

### 问题 6: CORS 错误

**错误信息:**
```
Access to fetch at '...' from origin '...' has been blocked by CORS policy
```

**解决方案:**

CORS 已配置，但可能需要重新部署：

```bash
npm run deploy
```

测试 CORS:
```bash
# 使用 curl 测试
curl -H "Origin: http://localhost:8080" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: Content-Type" \
  -X OPTIONS \
  https://id.nightcord.de5.net/.well-known/openid-configuration
```

## 调试技巧

### 1. 查看 Cloudflare Workers 日志

```bash
# 实时查看日志
wrangler tail

# 或在 Cloudflare Dashboard 查看
# Workers & Pages -> sekai-pass -> Logs
```

### 2. 检查数据库状态

```bash
# 列出所有表
wrangler d1 execute sekai_pass_db --command "SELECT name FROM sqlite_master WHERE type='table';" --remote

# 查看应用配置
wrangler d1 execute sekai_pass_db --command "SELECT id, name, client_id, redirect_uris FROM applications;" --remote
```

### 3. 测试端点

```bash
# OIDC Discovery
curl -s https://id.nightcord.de5.net/.well-known/openid-configuration | jq

# JWKS
curl -s https://id.nightcord.de5.net/.well-known/jwks.json | jq

# OAuth Discovery
curl -s https://id.nightcord.de5.net/.well-known/oauth-authorization-server | jq
```

### 4. 浏览器开发者工具

1. 打开开发者工具（F12）
2. 切换到 Console 标签查看 JavaScript 错误
3. 切换到 Network 标签查看 HTTP 请求
4. 查看失败请求的响应内容

## 完整的故障排查流程

```bash
# 1. 检查部署状态
wrangler deployments list

# 2. 检查数据库表
wrangler d1 execute sekai_pass_db --command "SELECT name FROM sqlite_master WHERE type='table';" --remote

# 3. 检查 secrets
wrangler secret list

# 4. 如果缺少 KEY_ENCRYPTION_SECRET，设置它
openssl rand -hex 32
wrangler secret put KEY_ENCRYPTION_SECRET

# 5. 检查 KV namespace 配置
# 查看 wrangler.toml 确保 KV namespace 已配置

# 6. 重新部署
npm run deploy

# 7. 测试端点
curl https://id.nightcord.de5.net/.well-known/openid-configuration

# 8. 查看实时日志
wrangler tail
```

## 获取帮助

如果问题仍未解决：

1. 查看 Cloudflare Workers 日志
2. 检查浏览器控制台错误
3. 查看 Network 标签的请求详情
4. 参考 implementation.md 文档

## 快速修复命令

```bash
# 确保所有配置正确后重新部署
npm run deploy
```
